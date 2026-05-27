-- 023: Professional profiles and skill endorsements

DO $$ BEGIN
  CREATE TYPE availability_enum AS ENUM ('available','not_taking_clients','open_to_opportunities','not_applicable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_professional_profiles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  occupation            TEXT,
  skills                TEXT[]      NOT NULL DEFAULT '{}',
  availability          availability_enum NOT NULL DEFAULT 'not_applicable',
  professional_bio      TEXT,
  portfolio_urls        JSONB       NOT NULL DEFAULT '[]',
  business_affiliations JSONB       NOT NULL DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_endorsements (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endorser_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endorsed_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill        TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(endorser_id, endorsed_id, skill)
);
