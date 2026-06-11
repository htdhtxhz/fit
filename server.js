require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Supabase client (service role — bypasses RLS for server ops) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: '*', // Allow all origins for HTML file access
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use(limiter);

// ── Auth middleware ───────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  req.token = token;
  next();
}

// ── Helper: user-scoped supabase client ──────────────────
function userSupabase(token) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
}

// ════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════

// Register
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Account created successfully', user_id: data.user.id });
});

// Login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email }
  });
});

// Refresh token
app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: 'Session expired — please login again' });

  res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at
  });
});

// Get current user
app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// Change password
app.post('/auth/change-password', requireAuth, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be 6+ characters' });
  }
  const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password: new_password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Password updated successfully' });
});

// ════════════════════════════════════════════════════════
// SYNC ROUTES — full state sync
// ════════════════════════════════════════════════════════

// Push full app state to server
app.post('/sync/push', requireAuth, async (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ error: 'State required' });

  try {
    const uid = req.user.id;

    // Sync workouts (per-day records)
    if (state.workouts) {
      for (const [date, exercises] of Object.entries(state.workouts)) {
        if (!exercises || !exercises.length) continue;
        await supabase.from('user_data').upsert({
          user_id: uid, data_key: 'workouts', date,
          data_value: exercises, updated_at: new Date()
        }, { onConflict: 'user_id,data_key,date' });
      }
    }

    // Sync food log (per-day)
    if (state.foods) {
      for (const [date, foods] of Object.entries(state.foods)) {
        if (!foods || !foods.length) continue;
        await supabase.from('user_data').upsert({
          user_id: uid, data_key: 'foods', date,
          data_value: foods, updated_at: new Date()
        }, { onConflict: 'user_id,data_key,date' });
      }
    }

    // Sync water (per-day)
    if (state.water) {
      for (const [date, glasses] of Object.entries(state.water)) {
        await supabase.from('user_data').upsert({
          user_id: uid, data_key: 'water', date,
          data_value: { glasses }, updated_at: new Date()
        }, { onConflict: 'user_id,data_key,date' });
      }
    }

    // Sync settings (single record)
    const settingsFields = ['targets','goal','waterGoal','weightUnit','theme','tdeeData'];
    const settings = {};
    settingsFields.forEach(k => { if (state[k] !== undefined) settings[k] = state[k]; });
    if (Object.keys(settings).length > 0) {
      await supabase.from('user_settings').upsert({
        user_id: uid,
        calorie_target: state.targets?.cal,
        protein_target: state.targets?.prot,
        goal_weight: state.goal,
        water_goal: state.waterGoal,
        weight_unit: state.weightUnit || 'kg',
        theme: state.theme || 'dark',
        tdee_data: state.tdeeData,
        updated_at: new Date()
      }, { onConflict: 'user_id' });
    }

    // Sync weights array
    if (state.weights?.length) {
      for (const w of state.weights) {
        await supabase.from('weight_log').upsert({
          user_id: uid, date: w.date, weight: w.val
        }, { onConflict: 'user_id,date' });
      }
    }

    // Sync habits
    if (state.habits?.length) {
      await supabase.from('user_data').upsert({
        user_id: uid, data_key: 'habits', date: 'global',
        data_value: state.habits, updated_at: new Date()
      }, { onConflict: 'user_id,data_key,date' });
    }

    // Sync habit completions
    if (state.habitDone) {
      await supabase.from('user_data').upsert({
        user_id: uid, data_key: 'habitDone', date: 'global',
        data_value: state.habitDone, updated_at: new Date()
      }, { onConflict: 'user_id,data_key,date' });
    }

    // Sync PRs
    if (state.prs && Object.keys(state.prs).length > 0) {
      await supabase.from('user_data').upsert({
        user_id: uid, data_key: 'prs', date: 'global',
        data_value: state.prs, updated_at: new Date()
      }, { onConflict: 'user_id,data_key,date' });
    }

    // Sync measurements
    if (state.measurements?.length) {
      await supabase.from('user_data').upsert({
        user_id: uid, data_key: 'measurements', date: 'global',
        data_value: state.measurements, updated_at: new Date()
      }, { onConflict: 'user_id,data_key,date' });
    }

    // Sync session notes
    if (state.sessionNotes) {
      await supabase.from('user_data').upsert({
        user_id: uid, data_key: 'sessionNotes', date: 'global',
        data_value: state.sessionNotes, updated_at: new Date()
      }, { onConflict: 'user_id,data_key,date' });
    }

    res.json({ message: 'Sync successful', synced_at: new Date() });
  } catch (e) {
    console.error('Push sync error:', e);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

// Pull full app state from server
app.get('/sync/pull', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;

    // Fetch all user_data records
    const { data: records, error } = await supabase
      .from('user_data')
      .select('*')
      .eq('user_id', uid)
      .order('date', { ascending: true });

    if (error) throw error;

    // Fetch settings
    const { data: settings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', uid)
      .single();

    // Fetch weight log
    const { data: weights } = await supabase
      .from('weight_log')
      .select('*')
      .eq('user_id', uid)
      .order('date', { ascending: true });

    // Reconstruct state
    const state = {
      workouts: {},
      foods: {},
      water: {},
      weights: [],
      habits: [],
      habitDone: {},
      prs: {},
      measurements: [],
      sessionNotes: {},
      targets: { cal: 2500, prot: 150 },
      goal: null,
      waterGoal: 8,
      weightUnit: 'kg',
      theme: 'dark',
      tdeeData: null,
      scanHistory: []
    };

    // Apply settings
    if (settings) {
      state.targets = { cal: settings.calorie_target || 2500, prot: settings.protein_target || 150 };
      state.goal = settings.goal_weight;
      state.waterGoal = settings.water_goal || 8;
      state.weightUnit = settings.weight_unit || 'kg';
      state.theme = settings.theme || 'dark';
      state.tdeeData = settings.tdee_data;
    }

    // Apply weights
    if (weights) {
      state.weights = weights.map(w => ({ date: w.date, val: parseFloat(w.weight) }));
    }

    // Apply user_data records
    if (records) {
      for (const r of records) {
        if (r.data_key === 'workouts' && r.date) {
          state.workouts[r.date] = r.data_value;
        } else if (r.data_key === 'foods' && r.date) {
          state.foods[r.date] = r.data_value;
        } else if (r.data_key === 'water' && r.date) {
          state.water[r.date] = r.data_value.glasses;
        } else if (r.data_key === 'habits') {
          state.habits = r.data_value;
        } else if (r.data_key === 'habitDone') {
          state.habitDone = r.data_value;
        } else if (r.data_key === 'prs') {
          state.prs = r.data_value;
        } else if (r.data_key === 'measurements') {
          state.measurements = r.data_value;
        } else if (r.data_key === 'sessionNotes') {
          state.sessionNotes = r.data_value;
        }
      }
    }

    res.json({ state, pulled_at: new Date() });
  } catch (e) {
    console.error('Pull sync error:', e);
    res.status(500).json({ error: 'Pull failed: ' + e.message });
  }
});

// ════════════════════════════════════════════════════════
// STATS ROUTES — journey tracking
// ════════════════════════════════════════════════════════

// Overall journey stats
app.get('/stats/journey', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;

    // Count workout days
    const { count: workoutDays } = await supabase
      .from('user_data')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid)
      .eq('data_key', 'workouts');

    // Weight progress
    const { data: weights } = await supabase
      .from('weight_log')
      .select('date, weight')
      .eq('user_id', uid)
      .order('date', { ascending: true });

    // First and latest workout
    const { data: firstWorkout } = await supabase
      .from('user_data')
      .select('date')
      .eq('user_id', uid)
      .eq('data_key', 'workouts')
      .order('date', { ascending: true })
      .limit(1);

    const { data: settings } = await supabase
      .from('user_settings')
      .select('goal_weight')
      .eq('user_id', uid)
      .single();

    // PRs count
    const { data: prsRecord } = await supabase
      .from('user_data')
      .select('data_value')
      .eq('user_id', uid)
      .eq('data_key', 'prs')
      .single();

    const prsCount = prsRecord ? Object.keys(prsRecord.data_value || {}).length : 0;
    const firstWeight = weights?.[0] ? parseFloat(weights[0].weight) : null;
    const latestWeight = weights?.[weights.length - 1] ? parseFloat(weights[weights.length - 1].weight) : null;
    const weightChange = firstWeight && latestWeight ? +(latestWeight - firstWeight).toFixed(1) : null;
    const daysSinceStart = firstWorkout?.[0]?.date
      ? Math.floor((Date.now() - new Date(firstWorkout[0].date)) / 86400000)
      : 0;

    res.json({
      workout_days: workoutDays || 0,
      days_since_start: daysSinceStart,
      weight_entries: weights?.length || 0,
      first_weight: firstWeight,
      latest_weight: latestWeight,
      weight_change: weightChange,
      goal_weight: settings?.goal_weight || null,
      prs_count: prsCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Weekly workout volume trend (last 8 weeks)
app.get('/stats/volume', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { data: records } = await supabase
      .from('user_data')
      .select('date, data_value')
      .eq('user_id', uid)
      .eq('data_key', 'workouts')
      .order('date', { ascending: true });

    if (!records) return res.json({ weeks: [] });

    // Group by week
    const weekMap = {};
    records.forEach(r => {
      const d = new Date(r.date + 'T00:00:00');
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      if (!weekMap[weekKey]) weekMap[weekKey] = { sets: 0, volume: 0, days: 0 };
      const exercises = r.data_value || [];
      weekMap[weekKey].days++;
      exercises.forEach(e => {
        weekMap[weekKey].sets += e.sets || 0;
        weekMap[weekKey].volume += (e.wt || 0) * (e.reps || 0) * (e.sets || 0);
      });
    });

    const weeks = Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-8)
      .map(([week, data]) => ({ week, ...data, volume: Math.round(data.volume) }));

    res.json({ weeks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Exercise history for a specific exercise
app.get('/stats/exercise/:name', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const exName = decodeURIComponent(req.params.name).toLowerCase();

    const { data: records } = await supabase
      .from('user_data')
      .select('date, data_value')
      .eq('user_id', uid)
      .eq('data_key', 'workouts')
      .order('date', { ascending: true });

    const history = [];
    records?.forEach(r => {
      const exercises = r.data_value || [];
      exercises.forEach(e => {
        if (e.ex?.toLowerCase() === exName) {
          const e1rm = +(e.wt * (1 + e.reps / 30)).toFixed(1);
          history.push({ date: r.date, weight: e.wt, reps: e.reps, sets: e.sets, e1rm });
        }
      });
    });

    res.json({ exercise: req.params.name, history: history.slice(-20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nutrition trends (last 30 days)
app.get('/stats/nutrition', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    const { data: records } = await supabase
      .from('user_data')
      .select('date, data_value')
      .eq('user_id', uid)
      .eq('data_key', 'foods')
      .gte('date', cutoff)
      .order('date', { ascending: true });

    const days = records?.map(r => {
      const foods = r.data_value || [];
      return {
        date: r.date,
        calories: foods.reduce((a, f) => a + (f.cal || 0), 0),
        protein: Math.round(foods.reduce((a, f) => a + (f.prot || 0), 0) * 10) / 10,
        carbs: Math.round(foods.reduce((a, f) => a + (f.carb || 0), 0) * 10) / 10,
        fat: Math.round(foods.reduce((a, f) => a + (f.fat || 0), 0) * 10) / 10,
      };
    }) || [];

    const avgCal = days.length ? Math.round(days.reduce((a, d) => a + d.calories, 0) / days.length) : 0;
    const avgProt = days.length ? Math.round(days.reduce((a, d) => a + d.protein, 0) / days.length * 10) / 10 : 0;

    res.json({ days, avg_calories: avgCal, avg_protein: avgProt, days_logged: days.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Habit streak stats
app.get('/stats/habits', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;

    const { data: habitsRec } = await supabase
      .from('user_data')
      .select('data_value')
      .eq('user_id', uid)
      .eq('data_key', 'habits')
      .single();

    const { data: doneRec } = await supabase
      .from('user_data')
      .select('data_value')
      .eq('user_id', uid)
      .eq('data_key', 'habitDone')
      .single();

    const habits = habitsRec?.data_value || [];
    const done = doneRec?.data_value || {};

    const today = new Date().toISOString().slice(0, 10);
    const stats = habits.map(h => {
      let streak = 0;
      const d = new Date();
      for (let i = 0; i < 60; i++) {
        const key = d.toISOString().slice(0, 10);
        if (done[key]?.[h.id]) { streak++; d.setDate(d.getDate() - 1); }
        else { if (i === 0) d.setDate(d.getDate() - 1); else break; }
      }
      return { name: h.name, id: h.id, streak, done_today: !!done[today]?.[h.id] };
    });

    res.json({ habits: stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date() });
});

app.get('/', (req, res) => {
  res.json({ message: 'FitLog API running', docs: 'See README.md' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`FitLog API running on port ${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? '✅ connected' : '❌ not configured'}`);
});

module.exports = app;
