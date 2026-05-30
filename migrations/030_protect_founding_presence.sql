-- 030: Extend founding account protection to verified and founding_member flags

-- Update the existing trigger to also block:
--   - Setting verified = false on AMBHaggermaker
--   - Setting founding_member = false on AMBHaggermaker
-- This applies to ALL updates, including direct DB queries.

CREATE OR REPLACE FUNCTION protect_founding_account() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.username = 'AMBHaggermaker' THEN
    IF NEW.role != OLD.role THEN
      RAISE EXCEPTION 'The founding account role cannot be changed';
    END IF;
    IF NEW.verified = false AND (OLD.verified IS DISTINCT FROM false) THEN
      RAISE EXCEPTION 'The founding account cannot be unverified';
    END IF;
    IF NEW.founding_member = false AND (OLD.founding_member IS DISTINCT FROM false) THEN
      RAISE EXCEPTION 'The founding account founding member status cannot be revoked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure current state is correct
UPDATE users SET verified = true, founding_member = true WHERE username = 'AMBHaggermaker';
