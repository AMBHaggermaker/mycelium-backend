-- Add verified and founding_member flags to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verified         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS founding_member  BOOLEAN NOT NULL DEFAULT FALSE;

-- Invitations sent by users
CREATE TABLE IF NOT EXISTS invitations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invited_by    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  token         UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  personal_note TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days')
);

CREATE INDEX IF NOT EXISTS idx_invitations_token      ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_invited_by ON invitations(invited_by);
CREATE INDEX IF NOT EXISTS idx_invitations_email      ON invitations(email);

-- Vouches: trust relationships between users
CREATE TABLE IF NOT EXISTS vouches (
  voucher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vouched_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (voucher_id, vouched_id)
);

CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_id);
CREATE INDEX IF NOT EXISTS idx_vouches_vouched ON vouches(vouched_id);
