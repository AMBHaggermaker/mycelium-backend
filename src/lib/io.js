// Shared Socket.IO instance — set once from index.js, used by routes to emit network activity.
let _io = null;
let _connected = 0;

module.exports = {
  set(io) { _io = io; },

  emit(event, data) {
    if (_io) _io.emit(event, data);
  },

  incConnected() {
    _connected++;
    if (_io) _io.emit('presence_update', { active: _connected });
  },

  decConnected() {
    _connected = Math.max(0, _connected - 1);
    if (_io) _io.emit('presence_update', { active: _connected });
  },

  getConnected() { return _connected; },

  networkActivity(type, data, severity = 'normal') {
    if (_io) _io.emit('network_activity', { type, severity, data, timestamp: new Date().toISOString() });
  },
};
