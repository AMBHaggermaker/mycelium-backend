-- Add commerce_type and price to posts
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS commerce_type VARCHAR(20) CHECK (commerce_type IN ('exchange','commerce','urgent')),
  ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);

-- Auto-assign urgent commerce_type based on auto_urgent flag
UPDATE posts SET commerce_type = 'urgent' WHERE auto_urgent = TRUE AND commerce_type IS NULL;

-- Watch reports table
CREATE TABLE IF NOT EXISTS watch_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_type VARCHAR(50) NOT NULL,
  title          VARCHAR(255) NOT NULL,
  description    TEXT,
  location_label VARCHAR(255),
  location_lat   NUMERIC(10,7),
  location_lng   NUMERIC(10,7),
  photo_urls     TEXT[] DEFAULT '{}',
  source_url     TEXT,
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watch_reports_dashboard ON watch_reports(dashboard_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_reports_user ON watch_reports(user_id);
