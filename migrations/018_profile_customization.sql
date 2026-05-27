-- 018: Profile customization — MySpace-style profile pages

-- ── Profile customization columns on users ───────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mood                TEXT,
  ADD COLUMN IF NOT EXISTS mood_emoji          TEXT,
  ADD COLUMN IF NOT EXISTS status_text         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS music_url           TEXT,
  ADD COLUMN IF NOT EXISTS music_label         TEXT,
  ADD COLUMN IF NOT EXISTS background_color    TEXT,
  ADD COLUMN IF NOT EXISTS background_gradient TEXT,
  ADD COLUMN IF NOT EXISTS accent_color        TEXT DEFAULT '#2a5f0a',
  ADD COLUMN IF NOT EXISTS font_style          VARCHAR(32) DEFAULT 'modern'
    CHECK (font_style IN ('classic','modern','typewriter','editorial')),
  ADD COLUMN IF NOT EXISTS layout              VARCHAR(32) DEFAULT 'standard'
    CHECK (layout IN ('standard','wide','minimal','sidebar')),
  ADD COLUMN IF NOT EXISTS banner_image_url    TEXT,
  ADD COLUMN IF NOT EXISTS profile_theme       VARCHAR(8) DEFAULT 'light'
    CHECK (profile_theme IN ('light','dark')),
  ADD COLUMN IF NOT EXISTS pinned_bulletin     VARCHAR(500),
  ADD COLUMN IF NOT EXISTS bulletin_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS interests           TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS website             TEXT;

-- ── Profile photos ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profile_photos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  caption          TEXT,
  album_name       TEXT DEFAULT 'General',
  is_profile_photo BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_photos_user ON profile_photos(user_id);

-- ── Profile albums ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profile_albums (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cover_photo_url TEXT,
  photo_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_albums_user ON profile_albums(user_id);

-- ── Wall posts ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wall_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wall_posts_profile ON wall_posts(profile_user_id, created_at DESC);
