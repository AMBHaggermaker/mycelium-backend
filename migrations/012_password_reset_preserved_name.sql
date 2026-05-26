-- Migration 012: password reset tokens + preserved display name for deleted accounts
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preserved_display_name TEXT,
  ADD COLUMN IF NOT EXISTS reset_token            TEXT,
  ADD COLUMN IF NOT EXISTS reset_expires_at       TIMESTAMPTZ;
