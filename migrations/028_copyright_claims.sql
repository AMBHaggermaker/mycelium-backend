-- Copyright protection tables

-- Add copyright flag to maker_works
ALTER TABLE maker_works
  ADD COLUMN IF NOT EXISTS copyright_flagged  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS published          BOOLEAN NOT NULL DEFAULT true;

-- Claims / takedown requests
CREATE TABLE IF NOT EXISTS copyright_claims (
  id                       SERIAL PRIMARY KEY,
  work_id                  INTEGER NOT NULL REFERENCES maker_works(id) ON DELETE CASCADE,
  claimant_name            VARCHAR(255) NOT NULL,
  claimant_email           VARCHAR(255) NOT NULL,
  original_work_desc       TEXT NOT NULL,
  good_faith_statement     BOOLEAN NOT NULL DEFAULT true,
  status                   VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','under_review','removed','dismissed')),
  admin_notes              TEXT,
  counter_notice_text      TEXT,
  counter_notice_at        TIMESTAMPTZ,
  counter_notice_status    VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (counter_notice_status IN ('none','received','accepted','rejected')),
  reviewed_by              UUID REFERENCES users(id),
  reviewed_at              TIMESTAMPTZ,
  r2_key_at_removal        TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Known copyrighted titles for automated flagging (seeded with common examples)
CREATE TABLE IF NOT EXISTS known_copyrighted_titles (
  id         SERIAL PRIMARY KEY,
  title      VARCHAR(255) NOT NULL UNIQUE,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a handful of well-known titles as examples
INSERT INTO known_copyrighted_titles (title, notes) VALUES
  ('Happy Birthday to You',   'Warner/Chappell claim — public domain since 2016 but often misused'),
  ('Sweet Home Alabama',      'Lynyrd Skynyrd'),
  ('Bohemian Rhapsody',       'Queen / Sony Music'),
  ('Stairway to Heaven',      'Led Zeppelin'),
  ('Smells Like Teen Spirit', 'Nirvana / Universal Music'),
  ('Yesterday',               'The Beatles / Sony ATV'),
  ('Hotel California',        'Eagles / Universal Music')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_copyright_claims_work   ON copyright_claims(work_id);
CREATE INDEX IF NOT EXISTS idx_copyright_claims_status ON copyright_claims(status);
CREATE INDEX IF NOT EXISTS idx_known_titles_lower      ON known_copyrighted_titles(lower(title));
