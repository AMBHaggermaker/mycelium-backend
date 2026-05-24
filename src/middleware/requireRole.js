module.exports = function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.role || 'member';
    if (!roles.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};
