-- Post comments
CREATE TABLE IF NOT EXISTS post_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL CHECK (char_length(content) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_post_comments_user ON post_comments(user_id);

-- Land development AI intelligence reports
CREATE TABLE IF NOT EXISTS land_development_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type    TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  affected_areas TEXT[] NOT NULL DEFAULT '{}',
  data_sources   TEXT[] NOT NULL DEFAULT '{}',
  ai_confidence  TEXT NOT NULL CHECK (ai_confidence IN ('low','medium','high')),
  raw_analysis   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_land_dev_reports_created ON land_development_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_land_dev_reports_type    ON land_development_reports(report_type);
