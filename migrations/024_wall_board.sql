-- Wall board enhancements: photos, pinning, privacy, notifications, thread links

-- Extend existing wall_posts table
ALTER TABLE wall_posts
  ADD COLUMN IF NOT EXISTS photo_urls     TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_pinned      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS collage_layout TEXT    DEFAULT 'single';

-- Wall privacy on profiles
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wall_privacy TEXT NOT NULL DEFAULT 'everyone';

-- Allow threads to link to wall posts
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS wall_post_id UUID REFERENCES wall_posts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_threads_wall_post ON threads(wall_post_id);

-- Platform notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  link       TEXT,
  read       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);
