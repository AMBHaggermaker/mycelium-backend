-- 021: Covenant agreement tracking
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS covenant_agreed    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS covenant_agreed_at TIMESTAMPTZ;
