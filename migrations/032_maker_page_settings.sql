ALTER TABLE maker_profiles
  ADD COLUMN IF NOT EXISTS page_settings jsonb DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS banner_url    text;
