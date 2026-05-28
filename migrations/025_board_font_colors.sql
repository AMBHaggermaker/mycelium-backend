-- Board header and body font color customization
ALTER TABLE profile_board_settings
  ADD COLUMN IF NOT EXISTS header_font_color VARCHAR(20),
  ADD COLUMN IF NOT EXISTS body_font_color   VARCHAR(20);
