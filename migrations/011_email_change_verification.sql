-- Pending email-change flow
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_pending TEXT,
  ADD COLUMN IF NOT EXISTS email_change_token TEXT,
  ADD COLUMN IF NOT EXISTS email_change_expires_at TIMESTAMPTZ;
