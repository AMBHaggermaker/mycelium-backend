-- 022: Business Pages

DO $$ BEGIN
  CREATE TYPE business_type_enum AS ENUM ('independently_owned','locally_owned_franchise','cooperative','nonprofit','sole_proprietor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_category_enum AS ENUM ('construction','retail','food_beverage','healthcare','legal','creative','trades','technology','childcare','education','agriculture','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contact_pref_enum AS ENUM ('platform_message','phone','email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS businesses (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name       TEXT        NOT NULL,
  business_type       business_type_enum NOT NULL,
  category            business_category_enum NOT NULL,
  description         TEXT,
  location_label      TEXT,
  service_area        TEXT,
  hours               JSONB,
  contact_phone       TEXT,
  contact_email       TEXT,
  contact_preference  contact_pref_enum NOT NULL DEFAULT 'platform_message',
  website_url         TEXT,
  is_verified_local   BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_photos (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url          TEXT        NOT NULL,
  caption      TEXT,
  is_cover     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_services (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  price_range  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link posts to a business page (optional)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

-- Add business_id to threads for recommendation threads
ALTER TABLE threads ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

-- Add parent_id to thread_messages for owner replies to recommendations
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES thread_messages(id) ON DELETE CASCADE;
