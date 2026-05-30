-- 031: User theme preferences for Cosmic Mycelium theme customization

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_preferences jsonb DEFAULT '{}' NOT NULL;

-- Default theme for all existing users
UPDATE users SET theme_preferences = '{"base":"cosmic","accent":"#00ff88","font":"mystical","starfield":true,"animation":"full"}' WHERE theme_preferences = '{}';
