-- 006: Add urgency flags and expiry to posts

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS is_urgent   BOOLEAN    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_urgent BOOLEAN    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_posts_auto_urgent ON posts(auto_urgent) WHERE auto_urgent = TRUE;
CREATE INDEX IF NOT EXISTS idx_posts_expires_at  ON posts(expires_at)  WHERE expires_at  IS NOT NULL;
