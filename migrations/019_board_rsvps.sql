-- Profile board settings (drag-and-drop order, visibility, colors)
CREATE TABLE IF NOT EXISTS profile_board_settings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_type       TEXT NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  is_visible       BOOLEAN NOT NULL DEFAULT true,
  background_color TEXT,
  font_color       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, board_type)
);
CREATE INDEX IF NOT EXISTS idx_board_settings_user ON profile_board_settings(user_id);

-- Post RSVPs (going / interested / saved)
CREATE TABLE IF NOT EXISTS post_rsvps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     VARCHAR(16) NOT NULL CHECK (status IN ('going', 'interested', 'saved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_post_rsvps_post ON post_rsvps(post_id);
CREATE INDEX IF NOT EXISTS idx_post_rsvps_user ON post_rsvps(user_id);
