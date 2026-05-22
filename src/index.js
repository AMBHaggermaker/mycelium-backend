require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
const errorHandler = require('./middleware/errorHandler');

const DIST = path.resolve('C:\\mycelium-app\\dist');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/circles', require('./routes/circles'));
app.use('/api/threads', require('./routes/threads'));
app.use('/api/search', require('./routes/search'));
app.use('/api/reservations', require('./routes/reservations'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Serve uploaded avatars
app.use('/api/uploads', express.static(path.resolve('uploads')));

// Serve React frontend — must come after all /api routes
app.use(express.static(DIST));
app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Mycelium API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
