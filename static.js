const express = require('express');
const path = require('path');
const fs = require('fs');

// Add static file serving to existing server
// Place fitness_tracker.html in the same folder as server.js

module.exports = function addStaticServing(app) {
  // Serve the HTML app at root
  app.get('/app', (req, res) => {
    const htmlPath = path.join(__dirname, 'fitness_tracker.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.send(`
        <h2>fitness_tracker.html not found</h2>
        <p>Upload fitness_tracker.html to the same folder as server.js on GitHub</p>
      `);
    }
  });
  
  // Also serve at /
  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'fitness_tracker.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.json({ message: 'FitLog API running', docs: 'See README.md', app: 'Upload fitness_tracker.html to access the app' });
    }
  });
};
