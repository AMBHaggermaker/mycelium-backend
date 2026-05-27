-- Atmospheric observations: separate table with classification and flight cross-reference
CREATE TABLE IF NOT EXISTS atmospheric_observations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  location_label           TEXT,
  location_lat             NUMERIC(9,6),
  location_lng             NUMERIC(9,6),
  severity                 TEXT NOT NULL CHECK (severity IN ('critical','serious','moderate','minor','monitoring')),
  report_type              TEXT NOT NULL CHECK (report_type IN (
                             'persistent_contrail','grid_pattern','low_altitude_trail',
                             'no_corresponding_flight','unusual_spray_pattern','other'
                           )),
  observation_duration_min INTEGER,
  estimated_altitude       TEXT CHECK (estimated_altitude IN ('low','medium','high')),
  wind_direction           TEXT,
  wind_speed_estimate      TEXT,
  weather_conditions       TEXT CHECK (weather_conditions IN ('clear','partly_cloudy','overcast','humid')),
  checked_flight_tracker   BOOLEAN DEFAULT FALSE,
  flight_tracking_result   TEXT CHECK (flight_tracking_result IN (
                             'matched_known_flight','no_match_found','partial_match','did_not_check'
                           )),
  photo_urls               TEXT[] NOT NULL DEFAULT '{}',
  source_url               TEXT,
  -- Auto-classification results
  classification           TEXT NOT NULL DEFAULT 'pending' CHECK (classification IN (
                             'explained','partial','unexplained','unidentified','pending'
                           )),
  matched_flights          JSONB,
  weather_data             JSONB,
  drift_zones              JSONB,
  classified_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Weather modification permits (admin-managed; publicly visible)
CREATE TABLE IF NOT EXISTS weather_modification_permits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator         TEXT NOT NULL,
  permit_type      TEXT NOT NULL,
  area_description TEXT NOT NULL,
  active_from      DATE,
  active_to        DATE,
  compounds_used   TEXT,
  source_url       TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Soil and rainwater lab samples
CREATE TABLE IF NOT EXISTS soil_samples (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sample_type             TEXT NOT NULL CHECK (sample_type IN ('soil_surface','soil_deep','rainwater')),
  collection_date         DATE,
  location_lat            NUMERIC(9,6),
  location_lng            NUMERIC(9,6),
  location_label          TEXT,
  distance_from_obs_miles NUMERIC(6,2),
  direction_from_obs      TEXT,
  linked_observation_id   UUID REFERENCES atmospheric_observations(id) ON DELETE SET NULL,
  lab_name                TEXT,
  lab_cert_number         TEXT,
  aluminum_ppb            NUMERIC(14,4),
  barium_ppb              NUMERIC(14,4),
  strontium_ppb           NUMERIC(14,4),
  silver_ppb              NUMERIC(14,4),
  tio2_ppb                NUMERIC(14,4),
  pfas_ppb                NUMERIC(14,4),
  photo_url               TEXT,
  tri_sources             JSONB,
  ai_assessment           JSONB,
  ai_confidence           TEXT CHECK (ai_confidence IN ('low','medium','high')),
  ai_assessed_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atmospheric FOIA tracker (Redstone airspace gap documentation)
CREATE TABLE IF NOT EXISTS atmospheric_foia (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_agency  TEXT NOT NULL,
  records_sought TEXT NOT NULL,
  submitted_date DATE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                   'pending','acknowledged','partial','fulfilled','denied','appealing'
                 )),
  response_due   DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the three Redstone Arsenal airspace tracking gaps
INSERT INTO atmospheric_foia (target_agency, records_sought, status, notes) VALUES
  ('FAA Air Traffic Organization',
   'Redstone Arsenal airspace waivers and special use authorizations affecting ADS-B flight tracking data gaps',
   'pending',
   'Tracking gap in public ADS-B coverage over Redstone Arsenal corridor — pending initial submission'),
  ('U.S. Army Aviation Center of Excellence',
   'General flight operation schedules and airspace utilization records for Redstone Arsenal',
   'pending',
   'Army records request — routine flight operations affecting atmospheric observation cross-referencing'),
  ('U.S. House Armed Services Committee',
   'Congressional oversight inquiry regarding public airspace transparency over Redstone Arsenal',
   'pending',
   'Seeking clarification on civilian ADS-B observation data gaps in the Redstone Arsenal area')
ON CONFLICT DO NOTHING;
