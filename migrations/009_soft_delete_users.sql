-- Soft-delete support for users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Index for common active-user queries
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users (is_active);
