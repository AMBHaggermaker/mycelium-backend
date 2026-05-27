CREATE TABLE IF NOT EXISTS soil_test_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_report_id   UUID NOT NULL REFERENCES watch_reports(id) ON DELETE CASCADE,
  sample_type       TEXT NOT NULL,
  collection_date   DATE,
  lab_name          TEXT,
  compounds_tested  TEXT[]  NOT NULL DEFAULT '{}',
  results           JSONB   NOT NULL DEFAULT '{}',
  lab_report_url    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_soil_tests_report ON soil_test_results(watch_report_id);
