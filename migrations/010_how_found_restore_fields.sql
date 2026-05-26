-- Fields for extended registration and account restore
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS how_found TEXT,
  ADD COLUMN IF NOT EXISTS original_username TEXT,
  ADD COLUMN IF NOT EXISTS original_email TEXT;
