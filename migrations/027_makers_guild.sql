-- Maker's Guild and Original Content Market tables

CREATE TABLE IF NOT EXISTS maker_profiles (
  id                   SERIAL PRIMARY KEY,
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  maker_name           VARCHAR(100) NOT NULL,
  bio                  TEXT,
  specialties          TEXT[] DEFAULT '{}',
  storage_used_bytes   BIGINT NOT NULL DEFAULT 0,
  storage_tier         VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (storage_tier IN ('free','basic','standard','pro')),
  stripe_subscription_id VARCHAR(255),
  tier_expires_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maker_works (
  id               SERIAL PRIMARY KEY,
  maker_id         INTEGER NOT NULL REFERENCES maker_profiles(id) ON DELETE CASCADE,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  category         VARCHAR(100) NOT NULL,
  work_type        VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (work_type IN ('audio','image','video','document','other')),
  r2_key           TEXT,
  r2_url           TEXT,
  file_size_bytes  BIGINT NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  is_free          BOOLEAN NOT NULL DEFAULT true,
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  preview_r2_key   TEXT,
  preview_r2_url   TEXT,
  play_count       INTEGER NOT NULL DEFAULT 0,
  download_count   INTEGER NOT NULL DEFAULT 0,
  tags             TEXT[] DEFAULT '{}',
  license          VARCHAR(50) NOT NULL DEFAULT 'all_rights_reserved' CHECK (license IN ('all_rights_reserved','creative_commons_attribution','creative_commons_sharealike','public_domain')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maker_commissions (
  id           SERIAL PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  maker_id     INTEGER NOT NULL REFERENCES maker_profiles(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  budget       DECIMAL(10,2),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','completed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maker_profiles_user ON maker_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_maker_works_maker ON maker_works(maker_id);
CREATE INDEX IF NOT EXISTS idx_maker_works_category ON maker_works(category);
CREATE INDEX IF NOT EXISTS idx_maker_works_work_type ON maker_works(work_type);
CREATE INDEX IF NOT EXISTS idx_maker_commissions_maker ON maker_commissions(maker_id);
CREATE INDEX IF NOT EXISTS idx_maker_commissions_requester ON maker_commissions(requester_id);
