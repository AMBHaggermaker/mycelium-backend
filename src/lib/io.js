// Shared Socket.IO instance + global presence map
let _io = null;

// userId (string) -> {
//   sockets: Set<socketId>, username, avatar_url, mood_emoji,
//   presence_status, online_visibility, lastActivity (ms)
// }
const _presence = {};
const AWAY_MS = 5 * 60 * 1000;

function _activeCount() {
  return Object.values(_presence).filter(d => d.presence_status !== 'offline').length;
}

function _publicList() {
  return Object.entries(_presence)
    .filter(([, d]) => d.presence_status !== 'offline' && d.online_visibility !== 'private')
    .map(([id, d]) => ({
      id,
      username:        d.username,
      avatar_url:      d.avatar_url  || null,
      mood_emoji:      d.mood_emoji  || null,
      presence_status: d.presence_status,
    }));
}

function _broadcast() {
  if (_io) _io.emit('presence_update', { active: _activeCount(), users: _publicList() });
}

module.exports = {
  set(io) {
    _io = io;
    // Mark users away after 5 min of inactivity
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const d of Object.values(_presence)) {
        if (d.presence_status === 'online' && now - d.lastActivity > AWAY_MS) {
          d.presence_status = 'away';
          changed = true;
        }
      }
      if (changed) _broadcast();
    }, 60_000);
  },

  // Kept for backward compat — no-ops since presence is now managed per-user
  incConnected() {},
  decConnected() {},
  getConnected() { return _activeCount(); },

  emit(event, data) { if (_io) _io.emit(event, data); },

  setUserPresence(userId, socketId, data) {
    const uid = String(userId);
    if (!_presence[uid]) {
      _presence[uid] = { sockets: new Set(), ...data, lastActivity: Date.now() };
    } else {
      Object.assign(_presence[uid], data);
      _presence[uid].lastActivity = Date.now();
    }
    _presence[uid].sockets.add(socketId);
    _broadcast();
  },

  removeSocket(userId, socketId) {
    const uid = String(userId);
    if (!_presence[uid]) return;
    _presence[uid].sockets.delete(socketId);
    if (_presence[uid].sockets.size === 0) delete _presence[uid];
    _broadcast();
  },

  updatePresenceStatus(userId, status) {
    const uid = String(userId);
    if (!_presence[uid]) return;
    _presence[uid].presence_status = status;
    _presence[uid].lastActivity = Date.now();
    _broadcast();
  },

  updateLastActivity(userId) {
    const uid = String(userId);
    if (!_presence[uid]) return;
    _presence[uid].lastActivity = Date.now();
    if (_presence[uid].presence_status === 'away') {
      _presence[uid].presence_status = 'online';
      _broadcast();
    }
  },

  getPresenceList(viewerId) {
    const vuid = viewerId ? String(viewerId) : null;
    return Object.entries(_presence)
      .filter(([uid, d]) => {
        if (d.presence_status === 'offline') return false;
        if (d.online_visibility === 'private' && uid !== vuid) return false;
        return true;
      })
      .map(([id, d]) => ({
        id,
        username:        d.username,
        avatar_url:      d.avatar_url  || null,
        mood_emoji:      d.mood_emoji  || null,
        presence_status: d.presence_status,
      }));
  },

  networkActivity(type, data, severity = 'normal') {
    if (_io) _io.emit('network_activity', { type, severity, data, timestamp: new Date().toISOString() });
  },

  toUser(userId, event, data) {
    if (_io) _io.to(`user:${userId}`).emit(event, data);
  },
};
