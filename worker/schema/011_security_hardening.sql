-- Security and legal-workflow hardening. Safe to run more than once.

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS electronic_service_email extensions.citext,
  ADD COLUMN IF NOT EXISTS electronic_service_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS electronic_service_source TEXT;

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_term_type_check;
ALTER TABLE leases ADD CONSTRAINT leases_term_type_check
  CHECK (term_type IN ('fixed','fixed_6','fixed_12','periodic')) NOT VALID;
ALTER TABLE leases VALIDATE CONSTRAINT leases_term_type_check;

-- Account claiming and password resetting must not share a token purpose.
-- Otherwise a claim link can be presented to the reset endpoint and consumed
-- without creating the account it was meant to create.
ALTER TABLE email_verifications DROP CONSTRAINT IF EXISTS email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_purpose_check
  CHECK (purpose IN ('tenant_claim','tenant_reset','staff_invite','email_change','signup'));

-- Browser retries and double-clicks must not create duplicate bookings or
-- applications. The client supplies an opaque request id; identity still
-- comes from the authenticated account.
ALTER TABLE showing_requests
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;
ALTER TABLE password_history
  ADD COLUMN IF NOT EXISTS params TEXT;
ALTER TABLE parking_allocations
  ADD COLUMN IF NOT EXISTS contact_id TEXT REFERENCES contacts(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_showing_request_once
  ON showing_requests(account_id, client_request_id)
  WHERE account_id IS NOT NULL AND client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_request_once
  ON applications(account_id, client_request_id)
  WHERE account_id IS NOT NULL AND client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_live
  ON sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_sessions_live
  ON tenant_sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_password_reset_live
  ON password_reset_tokens(token_hash) WHERE used_at IS NULL;

COMMIT;
