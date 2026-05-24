-- 003: Add category / subcategory tagging to posts
-- Run as: psql -U mycelium_user -d mycelium_db -f migrations/003_category_subcategory.sql

ALTER TABLE posts
  ADD COLUMN category    TEXT CHECK (category IN ('jobs_services', 'goods_supplies', 'community')),
  ADD COLUMN subcategory TEXT;

CREATE INDEX idx_posts_category    ON posts(category)    WHERE category    IS NOT NULL;
CREATE INDEX idx_posts_subcategory ON posts(subcategory) WHERE subcategory IS NOT NULL;

-- Rebuild FTS index to include subcategory
DROP INDEX idx_posts_fts;
CREATE INDEX idx_posts_fts ON posts USING GIN (
  to_tsvector('english',
    title || ' ' ||
    COALESCE(description, '') || ' ' ||
    COALESCE(subcategory, '')
  )
);
