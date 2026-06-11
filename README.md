# FitLog Backend API

## 🚀 Setup Guide (15 minutes, 100% free)

### Step 1 — Create Supabase project
1. Go to **supabase.com** → Sign up (free)
2. Click **New Project**
3. Choose a name (e.g. `fitlog`) and a strong database password
4. Wait ~2 min for it to provision
5. Go to **Settings → API**
6. Copy your **Project URL** and **service_role key** (keep secret!)
7. Go to **SQL Editor** → paste the entire contents of `supabase_schema.sql` → Run

### Step 2 — Deploy to Render
1. Push this folder to a **GitHub repo** (github.com → new repo → upload files)
2. Go to **render.com** → Sign up with GitHub (free)
3. Click **New → Web Service**
4. Connect your GitHub repo
5. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
6. Add Environment Variables:
   - `SUPABASE_URL` → your Supabase project URL
   - `SUPABASE_SERVICE_KEY` → your service_role key
   - `JWT_SECRET` → any random 32+ character string
7. Click **Deploy**
8. Wait ~3 min → you get a URL like `https://fitlog-api-xxxx.onrender.com`

### Step 3 — Connect to your HTML app
1. Open `fitness_tracker.html`
2. Go to **Settings** → Backend Sync section
3. Enter your Render URL
4. Create account / login
5. Hit **Sync** — all your data goes to the cloud!

## API Endpoints

### Auth
- `POST /auth/register` — create account
- `POST /auth/login` — login, get token
- `POST /auth/refresh` — refresh expired token
- `GET /auth/me` — get current user

### Sync
- `POST /sync/push` — push local state to server
- `GET /sync/pull` — pull server state to local

### Stats (journey tracking)
- `GET /stats/journey` — overall progress summary
- `GET /stats/volume` — weekly volume trend (8 weeks)
- `GET /stats/exercise/:name` — history for specific exercise
- `GET /stats/nutrition` — 30-day nutrition trends
- `GET /stats/habits` — habit streaks

### Health
- `GET /health` — server status

## Notes
- Free Render tier sleeps after 15 min inactivity (wakes in ~30s on next request)
- Free Supabase tier: 500MB storage, plenty for years of fitness data
- All data is encrypted and isolated per user (Row Level Security)
