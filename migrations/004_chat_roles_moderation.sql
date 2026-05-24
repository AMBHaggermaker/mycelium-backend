-- 004: chat rooms, messages, user roles, content moderation

-- ── User roles ───────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'moderator', 'admin'));

-- Set AMBHaggermaker as admin first (before protect trigger is installed)
UPDATE users SET role = 'admin' WHERE username = 'AMBHaggermaker';

-- Auto-promote AMBHaggermaker on INSERT (catches future registrations)
CREATE OR REPLACE FUNCTION set_founding_admin() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.username = 'AMBHaggermaker' THEN
    NEW.role := 'admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_founding_admin_trigger ON users;
CREATE TRIGGER set_founding_admin_trigger
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION set_founding_admin();

-- Protect founding account role from change (DB-level enforcement)
CREATE OR REPLACE FUNCTION protect_founding_account() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.username = 'AMBHaggermaker' AND NEW.role != OLD.role THEN
    RAISE EXCEPTION 'The founding account role cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_founding_account_trigger ON users;
CREATE TRIGGER protect_founding_account_trigger
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_founding_account();

-- ── Content moderation ───────────────────────────────────────────────────────
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS content_flagged BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS post_reports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id);

-- ── Chat rooms ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_rooms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  is_public   BOOLEAN NOT NULL DEFAULT TRUE,
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Chat messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created
  ON chat_messages(room_id, created_at DESC);

-- Trigger: keep only the last 500 messages per room
CREATE OR REPLACE FUNCTION trim_chat_messages() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM chat_messages
  WHERE room_id = NEW.room_id
    AND id NOT IN (
      SELECT id FROM chat_messages
      WHERE room_id = NEW.room_id
      ORDER BY created_at DESC
      LIMIT 500
    );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trim_chat_messages_trigger ON chat_messages;
CREATE TRIGGER trim_chat_messages_trigger
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION trim_chat_messages();

-- ── Seed default pinned rooms ────────────────────────────────────────────────
INSERT INTO chat_rooms (name, slug, description, is_public, pinned) VALUES
  ('General',    'general',    'Open conversation for the whole community',  TRUE, TRUE),
  ('Huntsville', 'huntsville', 'Local chat for Huntsville, AL',               TRUE, TRUE),
  ('Mutual Aid', 'mutual-aid', 'Coordinate mutual aid and resource sharing',  TRUE, TRUE)
ON CONFLICT (slug) DO NOTHING;
