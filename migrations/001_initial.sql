-- Mycelium community coordination platform — initial schema
-- Run as: psql -U mycelium_user -d mycelium_db -f migrations/001_initial.sql

-- ─── Extensions ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE post_type AS ENUM ('need', 'offer', 'event');
CREATE TYPE post_status AS ENUM ('active', 'fulfilled', 'cancelled');
CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed');

-- ─── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  username         VARCHAR(50) UNIQUE NOT NULL,
  email            VARCHAR(255) UNIQUE NOT NULL,
  password_hash    TEXT        NOT NULL,
  bio              TEXT,
  location         VARCHAR(255),
  reliability_score DECIMAL(4,2) DEFAULT 5.00
                   CHECK (reliability_score >= 0 AND reliability_score <= 10),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Circles (community groups) ──────────────────────────────────────────────

CREATE TABLE circles (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  is_private  BOOLEAN      DEFAULT FALSE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── Circle memberships ───────────────────────────────────────────────────────

CREATE TABLE circle_members (
  circle_id  UUID        NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (circle_id, user_id)
);

-- ─── Posts (needs / offers / events) ─────────────────────────────────────────

CREATE TABLE posts (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  type           post_type   NOT NULL,
  title          VARCHAR(255) NOT NULL,
  description    TEXT,
  user_id        UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  circle_id      UUID                 REFERENCES circles(id)  ON DELETE SET NULL,
  capacity       INTEGER     CHECK (capacity > 0),        -- NULL = unlimited
  reserved_count INTEGER     DEFAULT 0 CHECK (reserved_count >= 0),
  location       VARCHAR(255),
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  status         post_status DEFAULT 'active',
  tags           TEXT[]      DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Reservations ────────────────────────────────────────────────────────────

CREATE TABLE reservations (
  id         UUID               PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id    UUID               NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
  user_id    UUID               NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  status     reservation_status DEFAULT 'pending',
  notes      TEXT,
  created_at TIMESTAMPTZ        DEFAULT NOW(),
  updated_at TIMESTAMPTZ        DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);

-- ─── Threads (dialogue) ───────────────────────────────────────────────────────

CREATE TABLE threads (
  id         UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  title      VARCHAR(255) NOT NULL,
  post_id    UUID         REFERENCES posts(id)   ON DELETE CASCADE,
  circle_id  UUID         REFERENCES circles(id) ON DELETE CASCADE,
  created_by UUID         REFERENCES users(id)   ON DELETE SET NULL,
  created_at TIMESTAMPTZ  DEFAULT NOW(),
  CHECK (post_id IS NOT NULL OR circle_id IS NOT NULL)
);

-- ─── Thread messages ──────────────────────────────────────────────────────────

CREATE TABLE thread_messages (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id  UUID        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX idx_posts_user_id      ON posts(user_id);
CREATE INDEX idx_posts_circle_id    ON posts(circle_id);
CREATE INDEX idx_posts_type         ON posts(type);
CREATE INDEX idx_posts_status       ON posts(status);
CREATE INDEX idx_posts_created_at   ON posts(created_at DESC);
CREATE INDEX idx_posts_starts_at    ON posts(starts_at) WHERE starts_at IS NOT NULL;
CREATE INDEX idx_posts_tags         ON posts USING GIN(tags);

CREATE INDEX idx_reservations_post_id  ON reservations(post_id);
CREATE INDEX idx_reservations_user_id  ON reservations(user_id);
CREATE INDEX idx_reservations_status   ON reservations(status);

CREATE INDEX idx_thread_messages_thread_id ON thread_messages(thread_id);
CREATE INDEX idx_thread_messages_created   ON thread_messages(created_at ASC);

CREATE INDEX idx_threads_post_id   ON threads(post_id)   WHERE post_id   IS NOT NULL;
CREATE INDEX idx_threads_circle_id ON threads(circle_id) WHERE circle_id IS NOT NULL;

CREATE INDEX idx_circle_members_user_id ON circle_members(user_id);

-- Full-text search on posts
CREATE INDEX idx_posts_fts ON posts USING GIN (
  to_tsvector('english', title || ' ' || COALESCE(description, ''))
);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_circles_updated_at
  BEFORE UPDATE ON circles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_thread_messages_updated_at
  BEFORE UPDATE ON thread_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
