-- Professional Development Hub tables

CREATE TABLE IF NOT EXISTS pro_dev_courses (
  id               SERIAL PRIMARY KEY,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  category         VARCHAR(100) NOT NULL,
  skill_level      VARCHAR(20) NOT NULL DEFAULT 'beginner' CHECK (skill_level IN ('beginner','intermediate','advanced')),
  instructor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  format           VARCHAR(20) NOT NULL DEFAULT 'written' CHECK (format IN ('video','audio','written','live','workshop')),
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_free          BOOLEAN NOT NULL DEFAULT true,
  duration_minutes INTEGER,
  tags             TEXT[] DEFAULT '{}',
  enrollment_count INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pro_dev_enrollments (
  id           SERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    INTEGER NOT NULL REFERENCES pro_dev_courses(id) ON DELETE CASCADE,
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS pro_dev_resources (
  id            SERIAL PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES pro_dev_courses(id) ON DELETE CASCADE,
  title         VARCHAR(255) NOT NULL,
  resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('audio','video','document','link')),
  url           TEXT,
  r2_key        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pro_dev_courses_category ON pro_dev_courses(category);
CREATE INDEX IF NOT EXISTS idx_pro_dev_courses_instructor ON pro_dev_courses(instructor_id);
CREATE INDEX IF NOT EXISTS idx_pro_dev_enrollments_user ON pro_dev_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_pro_dev_enrollments_course ON pro_dev_enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_pro_dev_resources_course ON pro_dev_resources(course_id);
