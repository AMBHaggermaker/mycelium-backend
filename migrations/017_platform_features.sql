-- 017: Advocate surface, Veterans, First Responders, Schools, Direct Messaging

-- ── Users: new columns ───────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_veteran           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS veteran_confirmed     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS veteran_confirmed_count INTEGER NOT NULL DEFAULT 0;

-- Add school_rep to the role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'moderator', 'admin', 'school_rep'));

-- ── Posts: new columns ───────────────────────────────────────────────────────

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS veteran_friendly BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fr_display_as    VARCHAR(32);   -- null = normal, 'First Responder', 'Healthcare Worker'

-- ── Circles: circle_type ─────────────────────────────────────────────────────

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS circle_type VARCHAR(32);  -- null = normal, 'veteran_circle', 'homeschool_co_op'

-- ── Advocate: cases ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advocate_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_type        VARCHAR(64) NOT NULL
    CHECK (case_type IN (
      'medical_kidnapping','cps_overreach','elder_abuse',
      'psychiatric_hold_abuse','parental_rights_violation',
      'court_ordered_treatment','other'
    )),
  institution_name VARCHAR(255) NOT NULL,
  institution_type VARCHAR(64) NOT NULL
    CHECK (institution_type IN ('hospital','cps_agency','care_facility','court','other')),
  location_label   VARCHAR(255),
  incident_date    DATE,
  summary          TEXT NOT NULL,
  evidence_urls    TEXT[] NOT NULL DEFAULT '{}',
  timeline         JSONB NOT NULL DEFAULT '[]',
  status           VARCHAR(32) NOT NULL DEFAULT 'documenting'
    CHECK (status IN ('documenting','legal_action','resolved','withdrawn')),
  is_public                BOOLEAN NOT NULL DEFAULT false,
  family_consent_to_share  BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advocate_cases_user ON advocate_cases(user_id);
CREATE INDEX IF NOT EXISTS idx_advocate_cases_institution ON advocate_cases(institution_name);

-- ── Advocate: pattern reports ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advocate_pattern_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_name    VARCHAR(255) NOT NULL,
  institution_type    VARCHAR(64)  NOT NULL,
  location_label      VARCHAR(255),
  complaint_types     TEXT[] NOT NULL DEFAULT '{}',
  total_complaints    INTEGER NOT NULL DEFAULT 0,
  verified_complaints INTEGER NOT NULL DEFAULT 0,
  unverified_complaints INTEGER NOT NULL DEFAULT 0,
  time_period_start   DATE,
  time_period_end     DATE,
  ai_summary          TEXT,
  ai_confidence       VARCHAR(16) CHECK (ai_confidence IN ('low','medium','high')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Advocate: institution responses ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS institution_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_report_id UUID NOT NULL REFERENCES advocate_pattern_reports(id) ON DELETE CASCADE,
  institution_name  VARCHAR(255) NOT NULL,
  response_text     TEXT NOT NULL,
  submitted_by      VARCHAR(255),
  contact_email     VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Veterans: vouches ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS veteran_vouches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  veteran_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voucher_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(veteran_user_id, voucher_user_id)
);

-- ── First Responders: moral injury documentation ──────────────────────────────

CREATE TABLE IF NOT EXISTS moral_injury_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fr_role          VARCHAR(64) NOT NULL
    CHECK (fr_role IN ('law_enforcement','fire','ems','healthcare','other')),
  institution_name VARCHAR(255),
  institution_type VARCHAR(64),
  description      TEXT NOT NULL,
  is_anonymous     BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Schools: pages ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS school_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255) NOT NULL,
  school_type       VARCHAR(32) NOT NULL DEFAULT 'public'
    CHECK (school_type IN ('public','private','charter')),
  address           VARCHAR(500),
  principal_name    VARCHAR(255),
  website           VARCHAR(500),
  phone             VARCHAR(32),
  school_rep_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Schools: posts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS school_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  UUID NOT NULL REFERENCES school_pages(id) ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_type  VARCHAR(32) NOT NULL
    CHECK (post_type IN ('announcement','lost_found','volunteer_need','lunch_balance','supply_drive','event')),
  title      VARCHAR(255) NOT NULL,
  content    TEXT,
  photo_urls TEXT[] NOT NULL DEFAULT '{}',
  count_only INTEGER,  -- for lunch_balance: anonymized count of students needing help
  expires_at TIMESTAMPTZ,
  is_urgent  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_posts_school ON school_posts(school_id);
CREATE INDEX IF NOT EXISTS idx_school_posts_type ON school_posts(school_id, post_type);

-- Auto-expire lost_found school posts after 30 days
-- (handled in application layer via expires_at)

-- ── Direct Messages ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  read         BOOLEAN NOT NULL DEFAULT false,
  reported     BOOLEAN NOT NULL DEFAULT false,
  report_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_read ON messages(recipient_id, read);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(
  LEAST(sender_id::text, recipient_id::text),
  GREATEST(sender_id::text, recipient_id::text),
  created_at DESC
);

-- ── Blocked users ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blocked_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, blocked_user_id)
);
