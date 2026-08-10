-- ============================================================
-- Baydo Pointe — renewals
--
-- A lease ending is the cheapest tenant there is. Finding a new
-- one costs a vacancy, a turnover and the leasing work; keeping
-- this one costs a conversation eight weeks early.
--
-- The order here matters. The Property Manager sets the terms
-- first, and the tenant answers those terms. "Will you be
-- staying?" with no rent attached is a question nobody can
-- answer, and asking it first wastes the one round of
-- correspondence that might have settled it.
--
-- Two outcomes need different paperwork:
--
--   month to month   often continues under the existing
--                    agreement, so nothing new is signed. Whether
--                    that is true depends on what the original
--                    lease says — confirm with your manager
--                    before relying on it.
--
--   new fixed term   a new agreement, signed by both parties.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS renewal_offers (
  id              TEXT PRIMARY KEY,
  lease_id        TEXT NOT NULL REFERENCES leases(id),
  unit_number     TEXT NOT NULL REFERENCES units(unit_number),
  contact_id      TEXT REFERENCES contacts(id),
  account_id      TEXT REFERENCES tenant_accounts(id),

  -- What is being offered.
  outcome         TEXT NOT NULL CHECK (outcome IN
                    ('fixed_term','month_to_month','not_renewing')),
  current_rent    NUMERIC(14,2) NOT NULL,
  offered_rent    NUMERIC(14,2),
  term_months     INTEGER,
  starts_on       DATE NOT NULL,
  ends_on         DATE,

  -- Whether a signature is needed, and which agreement it comes from.
  -- A month-to-month continuation usually is not signed; a new fixed term
  -- always is.
  requires_signature BOOLEAN NOT NULL DEFAULT TRUE,
  agreement_id    TEXT REFERENCES agreements(id),
  signature_request_id TEXT REFERENCES signature_requests(id),

  -- The rent-increase rule. Recorded at the moment of the offer rather than
  -- recalculated later, because whether it was legal depends on what was true
  -- when the notice went out.
  last_increase_on DATE,
  days_since_increase INTEGER,
  increase_permitted BOOLEAN,
  notice_days     INTEGER,
  notice_due_by   DATE,

  message         TEXT,
  internal_note   TEXT,

  state           TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','sent','viewed','accepted','declined',
                                   'signing','completed','expired','withdrawn')),
  -- The tenant's own words. What somebody says when they decline is the most
  -- useful thing in this table: it is the only place the reason a tenancy
  -- ended is written down by the person who ended it.
  response_note   TEXT,
  responded_at    TIMESTAMPTZ,
  response_ip     TEXT,

  access_token    TEXT UNIQUE,
  expires_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  viewed_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  decided_by      TEXT REFERENCES users(id),
  decided_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_renewal_state ON renewal_offers(state, notice_due_by);
CREATE INDEX IF NOT EXISTS idx_renewal_lease ON renewal_offers(lease_id);

-- One live offer per lease. Two would mean a tenant holding two sets of terms
-- with nothing to say which one they accepted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_one_live
  ON renewal_offers(lease_id)
  WHERE state IN ('draft','sent','viewed','accepted','signing');

-- What the tenant was asked and what they said, kept even after the offer is
-- superseded. A tenant who declined in March and stayed anyway is a
-- conversation somebody had, and it should not vanish when the next offer
-- goes out.
CREATE TABLE IF NOT EXISTS renewal_events (
  id          TEXT PRIMARY KEY,
  offer_id    TEXT NOT NULL REFERENCES renewal_offers(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      TEXT,
  actor_name  TEXT,
  ip          TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revent ON renewal_events(offer_id, at);

-- The lease needs to know it was renewed, and from what.
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS renewed_from TEXT REFERENCES leases(id),
  ADD COLUMN IF NOT EXISTS renewal_offer_id TEXT REFERENCES renewal_offers(id);

COMMIT;

