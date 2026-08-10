-- ============================================================
-- Baydo Pointe — accounts before tenancy
--
-- Somebody signs up before they have a suite. They book a
-- viewing, apply, and follow what happens to the application.
-- Later, if they sign a lease, the same account gains access to
-- the tenancy.
--
-- One account, two states. The distinction that matters:
--
--   prospect  self-service. Email verified, nothing else claimed.
--             Sees only what they themselves submitted.
--
--   tenant    linked to a lease BY STAFF. Sees the tenancy.
--
-- The upgrade is never self-service. If somebody could attach
-- their own account to a suite, the portal would show them
-- another household's lease, and the sign-up form would be the
-- way in. Staff link the account when the lease is signed,
-- because staff are the ones who know it was.
-- ============================================================

BEGIN;

-- Signing up is a new purpose for a verification token.
ALTER TABLE email_verifications DROP CONSTRAINT IF EXISTS email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_purpose_check
  CHECK (purpose IN ('tenant_claim','staff_invite','email_change','signup'));

ALTER TABLE tenant_accounts
  ADD COLUMN IF NOT EXISTS account_state TEXT NOT NULL DEFAULT 'prospect'
    CHECK (account_state IN ('prospect','tenant','former')),
  ADD COLUMN IF NOT EXISTS linked_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signup_ip TEXT,
  ADD COLUMN IF NOT EXISTS moved_out_at TIMESTAMPTZ;

-- unit_number is null for a prospect, so the old unique index would allow
-- only one of them. It has to be conditional on actually having a suite.
DROP INDEX IF EXISTS idx_tenant_accounts_unit;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_unit
  ON tenant_accounts(unit_number)
  WHERE is_active AND unit_number IS NOT NULL AND account_state = 'tenant';

-- Email is still unique across everybody. Two accounts on one address is how
-- somebody ends up unable to explain which of them holds their application.
DROP INDEX IF EXISTS idx_tenant_accounts_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_email
  ON tenant_accounts(lower(email)) WHERE is_active;

-- Existing rows came from the claim flow, so they are tenants.
UPDATE tenant_accounts SET account_state = 'tenant'
  WHERE unit_number IS NOT NULL AND account_state = 'prospect';

ALTER TABLE tenant_accounts ALTER COLUMN unit_number DROP NOT NULL;
ALTER TABLE tenant_accounts ALTER COLUMN full_name DROP NOT NULL;

-- What a prospect does. Viewings and applications belong to the account, so
-- somebody can see their own without staff looking anything up.
ALTER TABLE showing_requests
  ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES tenant_accounts(id);
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES tenant_accounts(id);

CREATE INDEX IF NOT EXISTS idx_showing_account ON showing_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_application_account ON applications(account_id);

-- Signups, for the same reason claim attempts are kept: a run of them from
-- one address is not a person looking for somewhere to live.
CREATE TABLE IF NOT EXISTS signup_attempts (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  outcome    TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signup_ip ON signup_attempts(ip, created_at DESC);

COMMIT;

