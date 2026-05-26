require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const errorHandler = require('./middleware/errorHandler');

const DIST = path.resolve('C:\\mycelium-app\\dist');
const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  path: '/api/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/users',        require('./routes/users'));
app.use('/api/posts',        require('./routes/posts'));
app.use('/api/circles',      require('./routes/circles'));
app.use('/api/threads',      require('./routes/threads'));
app.use('/api/search',       require('./routes/search'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/chat',         require('./routes/chat'));
app.use('/api/admin',        require('./routes/admin'));
app.use('/api/watch',        require('./routes/watch'));
app.use('/api/invitations',  require('./routes/invitations'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/api/uploads', express.static(path.resolve('uploads')));
app.use(express.static(DIST));
app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
app.use(errorHandler);

// ── Socket.IO ────────────────────────────────────────────────────────────────
// roomPresence[slug] = Map<socketId, { id, username }>
const roomPresence = {};
// lastActivity[slug] = ISO timestamp of most recent message
const lastActivity = {};

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth_required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('invalid_token'));
  }
});

function getRoomCounts() {
  return Object.fromEntries(
    Object.entries(roomPresence).map(([slug, m]) => [slug, m.size])
  );
}

io.on('connection', (socket) => {
  const user = socket.user;

  socket.on('join_room', (slug) => {
    socket.join(`room:${slug}`);
    if (!roomPresence[slug]) roomPresence[slug] = new Map();
    roomPresence[slug].set(socket.id, { id: user.id, username: user.username });

    const users = [...roomPresence[slug].values()];
    io.to(`room:${slug}`).emit('room_presence', { slug, users });
    io.emit('room_list_update', { counts: getRoomCounts(), lastActivity });
  });

  socket.on('leave_room', (slug) => {
    socket.leave(`room:${slug}`);
    if (roomPresence[slug]) {
      roomPresence[slug].delete(socket.id);
      if (roomPresence[slug].size === 0) delete roomPresence[slug];
    }
    const users = roomPresence[slug] ? [...roomPresence[slug].values()] : [];
    io.to(`room:${slug}`).emit('room_presence', { slug, users });
    io.emit('room_list_update', { counts: getRoomCounts(), lastActivity });
  });

  socket.on('chat_message', async ({ room_slug, content }) => {
    if (!content?.trim()) return;
    try {
      const room = await pool.query('SELECT id FROM chat_rooms WHERE slug = $1', [room_slug]);
      if (!room.rows[0]) return;

      const result = await pool.query(
        `INSERT INTO chat_messages (room_id, user_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, room_id, user_id, content, created_at`,
        [room.rows[0].id, user.id, content.trim()]
      );
      const msg = result.rows[0];
      lastActivity[room_slug] = msg.created_at.toISOString();

      io.to(`room:${room_slug}`).emit('chat_message', {
        ...msg,
        username: user.username,
        room_slug,
      });
      io.emit('room_list_update', { counts: getRoomCounts(), lastActivity });
    } catch (e) {
      console.error('chat_message socket error:', e.message);
    }
  });

  socket.on('disconnect', () => {
    for (const [slug, presenceMap] of Object.entries(roomPresence)) {
      if (presenceMap.has(socket.id)) {
        presenceMap.delete(socket.id);
        if (presenceMap.size === 0) delete roomPresence[slug];
        const users = roomPresence[slug] ? [...roomPresence[slug].values()] : [];
        io.to(`room:${slug}`).emit('room_presence', { slug, users });
      }
    }
    io.emit('room_list_update', { counts: getRoomCounts(), lastActivity });
  });
});

httpServer.listen(PORT, () => {
  console.log(`Mycelium API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
