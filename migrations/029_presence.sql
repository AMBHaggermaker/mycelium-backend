-- 029: User presence status and online visibility

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS presence_status    TEXT DEFAULT 'online'
    CHECK (presence_status IN ('online', 'busy', 'away', 'offline')),
  ADD COLUMN IF NOT EXISTS online_visibility  TEXT DEFAULT 'public'
    CHECK (online_visibility IN ('public', 'private'));
