-- ============================================================
-- Baydo Pointe — rent increases
--
-- Every tenancy has its own clock.
--
-- The 365 days run from that tenant's last increase, or from the
-- day their tenancy started. They do not run from a date the
-- landlord picks, and 330 suites signed across three years have
-- 330 different anniversaries.
--
-- So there is no batch. There is a policy — what the increase
-- should be — and each tenancy reaches its own eligibility date
-- and gets its own notice, timed to itself.
--
-- A calendar batch is wrong in both directions at once. Served
-- before a tenancy is eligible, the notice is void and the rent
-- stays put until a fresh one has run its course. Served after,
-- every month of delay is a month of the difference given away.
--
-- Alberta has no rent control, so there is no cap on the amount.
-- What is absolute is the timing and the notice, and getting
-- either wrong does not reduce the increase — it removes it.
--
-- Every figure here is a legal one. Confirm each before the first
-- notice goes out.
-- ============================================================

BEGIN;

/* What an increase should be. One rule, applied to each tenancy when that
   tenancy reaches its own date.
   
   Versioned by effective date rather than edited, for the same reason the fee
   formulas are: a notice already served was calculated under the rule that
   existed then, and rewriting the rule should not restate it. */
CREATE TABLE IF NOT EXISTS rent_increase_policies (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,

  method        TEXT NOT NULL CHECK (method IN ('percent','fixed','to_market')),
  percent       NUMERIC(10,6),
  fixed_amount  NUMERIC(14,2),
  rounding      TEXT NOT NULL DEFAULT 'none'
                CHECK (rounding IN ('none','nearest_5','nearest_10')),

  -- A ceiling on what any one tenancy can move in a single step. Not the law
  -- — Alberta has no cap — but a tenant who would have stayed and does not is
  -- a turnover, and a turnover usually costs more than the difference.
  max_percent   NUMERIC(10,6),
  max_amount    NUMERIC(14,2),

  -- Which tenancies it covers. A fixed term cannot be increased mid-term at
  -- all: the rent is what the agreement says until the agreement ends. So
  -- this only ever applies to periodic tenancies, and a fixed term gets its
  -- new rent at renewal instead.
  applies_to    TEXT NOT NULL DEFAULT 'periodic'
                CHECK (applies_to IN ('periodic')),

  effective_from DATE NOT NULL,
  effective_to   DATE,
  note          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rent_increases (
  id            TEXT PRIMARY KEY,
  policy_id     TEXT REFERENCES rent_increase_policies(id),
  lease_id      TEXT NOT NULL REFERENCES leases(id),
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),

  current_rent  NUMERIC(14,2) NOT NULL,
  new_rent      NUMERIC(14,2) NOT NULL,
  increase_amount NUMERIC(14,2) NOT NULL,
  increase_percent NUMERIC(10,6) NOT NULL,

  /* The eligibility check, frozen at the moment the notice was prepared.
     
     Recalculating it later gives the wrong answer. Whether a notice was valid
     depends on what was true when it was served, and by the time anybody
     disputes it the underlying dates have moved on. */
  anniversary_of     DATE,          -- last increase, or tenancy start
  days_since         INTEGER,
  eligible_from      DATE NOT NULL, -- this tenancy's own earliest date
  eligible           BOOLEAN NOT NULL,
  ineligible_reason  TEXT,

  /* Service. An increase turns on this far more often than on the amount. */
  notice_days        INTEGER NOT NULL,
  effective_on       DATE NOT NULL,
  served_on          DATE,
  deemed_served_on   DATE,
  service_method     TEXT CHECK (service_method IN
                       ('email','post','personal','posted_on_door','courier')),
  served_by          TEXT,
  witness            TEXT,
  outbox_id          TEXT REFERENCES outbox(id),
  delivery_state     TEXT DEFAULT 'pending',
  evidence_key       TEXT,
  evidence_sha256    TEXT,

  notice_text        TEXT,
  notice_sha256      TEXT,

  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','served','applied','withdrawn','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at   TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,
  withdrawn_reason TEXT,
  tenant_response  TEXT,
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ri_state ON rent_increases(state, effective_on);
CREATE INDEX IF NOT EXISTS idx_ri_lease ON rent_increases(lease_id);

-- One live notice per tenancy. Two with different figures leaves nobody able
-- to say which applies, and the tenant gets to choose.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ri_one_live
  ON rent_increases(lease_id) WHERE state IN ('draft','served');

CREATE TABLE IF NOT EXISTS rent_increase_events (
  id          TEXT PRIMARY KEY,
  increase_id TEXT NOT NULL REFERENCES rent_increases(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      TEXT,
  actor_name  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* An increase cannot take effect before its own notice has run.
   
   Here rather than only in the code, because this is the rule that voids the
   whole thing. A notice deemed served on the 1st with an effective date two
   weeks later is not a short increase — it is no increase, and the rent stays
   where it was until a fresh notice has run its full period. */
CREATE OR REPLACE FUNCTION check_increase_notice() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state NOT IN ('served','applied') OR NEW.deemed_served_on IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.effective_on < NEW.deemed_served_on + NEW.notice_days THEN
    RAISE EXCEPTION
      'Notice for % is deemed served on % and needs % days, so the earliest effective date is %. Serving it for % would make the increase void rather than late.',
      NEW.unit_number, NEW.deemed_served_on, NEW.notice_days,
      NEW.deemed_served_on + NEW.notice_days, NEW.effective_on;
  END IF;

  -- And not before this tenancy's own anniversary.
  IF NEW.effective_on < NEW.eligible_from THEN
    RAISE EXCEPTION
      'This tenancy is not eligible until %. An increase effective % would be served too soon and the notice would be void.',
      NEW.eligible_from, NEW.effective_on;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_increase_notice ON rent_increases;
CREATE TRIGGER trg_increase_notice
  BEFORE INSERT OR UPDATE ON rent_increases
  FOR EACH ROW EXECUTE FUNCTION check_increase_notice();

/* Each tenancy with its own dates. A view because the same question is asked
   from the queue, from the dashboard and from the SQL editor, and three
   definitions would give three answers. */
CREATE OR REPLACE VIEW rent_increase_eligibility AS
SELECT
  l.id                AS lease_id,
  l.unit_number,
  l.rent              AS current_rent,
  l.term_type,
  l.start_date,
  l.last_increase_at,
  -- The clock runs from the last increase, or from the start if there has
  -- never been one.
  COALESCE(l.last_increase_at, l.start_date) AS anniversary_of,
  CURRENT_DATE - COALESCE(l.last_increase_at, l.start_date) AS days_since,
  (COALESCE(l.last_increase_at, l.start_date) + INTERVAL '365 days')::date
    AS eligible_from,
  -- Serving is possible before the effective date, by the notice period.
  ((COALESCE(l.last_increase_at, l.start_date) + INTERVAL '365 days')
    - INTERVAL '90 days')::date AS can_serve_from,
  (COALESCE(l.last_increase_at, l.start_date)
    <= CURRENT_DATE - INTERVAL '365 days') AS eligible_now,
  -- A fixed term cannot be increased mid-term. Its rent is what the agreement
  -- says until the agreement ends, and the new figure goes in the renewal.
  (l.term_type = 'periodic') AS can_be_increased,
  EXISTS (SELECT 1 FROM rent_increases ri
          WHERE ri.lease_id = l.id AND ri.state IN ('draft','served'))
    AS has_live_notice
FROM leases l
WHERE l.status = 'active';

COMMIT;
