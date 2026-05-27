-- Community-submitted land development records
CREATE TABLE IF NOT EXISTS land_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type      TEXT NOT NULL CHECK (record_type IN (
                     'property_transfer','annexation_filing','zoning_change','planning_decision')),
  submitted_by     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- shared across all types
  location_label   TEXT,
  record_date      DATE,
  source_url       TEXT,
  notes            TEXT,
  verified         BOOLEAN NOT NULL DEFAULT FALSE,

  -- property_transfer
  address          TEXT,
  buyer            TEXT,
  seller           TEXT,
  sale_price       NUMERIC(14,2),

  -- annexation_filing
  area_affected    TEXT,
  petitioner       TEXT,

  -- zoning_change
  from_zone        TEXT,
  to_zone          TEXT,
  requesting_party TEXT,

  -- planning_decision
  project_name     TEXT,
  decision         TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_land_records_type    ON land_records(record_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_land_records_buyer   ON land_records(buyer);
CREATE INDEX IF NOT EXISTS idx_land_records_created ON land_records(created_at DESC);

-- Public records request tracker (admin-managed)
CREATE TABLE IF NOT EXISTS records_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency         TEXT NOT NULL,
  records_sought TEXT NOT NULL,
  submitted_date DATE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','acknowledged','partial','fulfilled','denied','appealing')),
  response_due   DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_records_requests_status ON records_requests(status, created_at DESC);
