-- Migration 013: severity + report_type on watch_reports, watch_anomalies table
ALTER TABLE watch_reports
  ADD COLUMN IF NOT EXISTS severity    TEXT DEFAULT 'monitoring'
    CHECK (severity IN ('critical','serious','moderate','minor','monitoring')),
  ADD COLUMN IF NOT EXISTS report_type TEXT;

CREATE TABLE IF NOT EXISTS watch_anomalies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anomaly_type     TEXT NOT NULL,
  description      TEXT NOT NULL,
  affected_reports UUID[] NOT NULL DEFAULT '{}',
  severity         TEXT NOT NULL CHECK (severity IN ('critical','serious','moderate','minor','monitoring')),
  dashboard_types  TEXT[] NOT NULL DEFAULT '{}',
  location_label   TEXT,
  ai_confidence    TEXT NOT NULL CHECK (ai_confidence IN ('low','medium','high')),
  reviewed         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watch_anomalies_severity  ON watch_anomalies (severity);
CREATE INDEX IF NOT EXISTS idx_watch_anomalies_reviewed  ON watch_anomalies (reviewed);
CREATE INDEX IF NOT EXISTS idx_watch_reports_severity    ON watch_reports (severity);
CREATE INDEX IF NOT EXISTS idx_watch_reports_dashboard   ON watch_reports (dashboard_type);
