-- ============================================================
-- Baydo Pointe — email verification and account claiming
--
-- Two flows, deliberately different.
--
-- Staff accounts are created by Admin. Nobody self-registers into
-- a system that can post to the ledger, and an invitation is the
-- only way in.
--
-- Tenant accounts are claimed rather than created. Somebody proves
-- they are the person on a lease by receiving mail at the address
-- already on that lease. Letting anyone who types a suite number
-- open an account would be worse than having no portal — they
-- would see somebody else's tenancy.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_verifications (
  id            TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN
                  ('tenant_claim','staff_invite','email_change')),

  email         TEXT NOT NULL,
  -- What this token is for. A tenant claim names the lease it was matched
  -- against, so the account cannot be pointed at a different suite between
  -- the email going out and the link being opened.
  unit_number   TEXT REFERENCES units(unit_number),
  lease_id      TEXT REFERENCES leases(id),
  contact_id    TEXT REFERENCES contacts(id),
  user_id       TEXT REFERENCES users(id),
  role_code     TEXT REFERENCES roles(code),
  full_name     TEXT,
  locale        TEXT DEFAULT 'en',

  -- Hashed, never stored raw. The table is a list of live credentials
  -- otherwise, and a backup of it is a way into every pending account.
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,

  -- Resending is rate limited per address rather than per token, so asking
  -- again does not reset the clock by starting a new row.
  sent_count    INTEGER NOT NULL DEFAULT 1,
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  requested_ip  TEXT,
  claimed_ip    TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verif_email ON email_verifications(email, purpose);
CREATE INDEX IF NOT EXISTS idx_verif_expiry ON email_verifications(expires_at)
  WHERE used_at IS NULL;

-- Attempts to claim an account, whether or not they matched.
--
-- Kept because a run of failures against different suites from one address is
-- somebody working through the building, and that is only visible if the
-- misses are recorded. The response is identical either way, so the log is
-- the only place the difference exists.
CREATE TABLE IF NOT EXISTS claim_attempts (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  unit_number  TEXT,
  matched      BOOLEAN NOT NULL DEFAULT FALSE,
  reason       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_ip ON claim_attempts(ip, created_at DESC);

-- Columns the accounts tables need for verification.
ALTER TABLE tenant_accounts
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_params TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_params TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invited_by TEXT REFERENCES users(id);

-- Contacts hold the email a lease is matched against.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS normalised_email TEXT,
  ADD COLUMN IF NOT EXISTS normalised_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_norm_email
  ON contacts(normalised_email) WHERE normalised_email IS NOT NULL;

-- One account per suite. Two would mean two people seeing the same tenancy
-- with no way to tell which of them the lease actually names.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_unit
  ON tenant_accounts(unit_number) WHERE is_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_email
  ON tenant_accounts(lower(email)) WHERE is_active;

COMMIT;
