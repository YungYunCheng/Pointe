-- ============================================================
-- Baydo Pointe — dates come from the agreement, not the clock
--
-- Every date that decides something legal is the date written on
-- the agreement. Not when it was signed, not when it was entered,
-- and not when somebody pressed send.
--
-- The distinction is not pedantic. A lease commencing 1 January
-- and signed on the 20th has its anniversary on 1 January. Taking
-- the signing date instead gives away nineteen days of a rent
-- increase, every year, on every suite where the paperwork lagged
-- — which is most of them.
-- ============================================================

BEGIN;

/* last_increase_at was TIMESTAMPTZ, which is a moment. A tenancy anniversary
   is a date, and storing it as a moment carries the hour somebody happened to
   click into a calculation that should not know about it.
   
   With a timestamp, a lease starting 1 September at 14:30 is not eligible on
   1 September the following year until 14:30. Five and a half hours short,
   for no reason a tenant or a tribunal would recognise, and the notice
   prepared that morning is refused. */
-- last_increase_at is declared DATE in 001 rather than converted here.
-- Building it as a timestamp and altering it in the same file would leave
-- somebody reading this wondering which one it really is.

COMMENT ON COLUMN leases.last_increase_at IS
  'The date the rent last changed, as written on the agreement or the notice. Not when it was signed or entered. NULL means it has never changed, and the clock runs from start_date.';

COMMENT ON COLUMN leases.start_date IS
  'Commencement, as written on the agreement. This is what every anniversary runs from. It is not the signing date and it is not created_at.';

COMMENT ON COLUMN leases.created_at IS
  'When this row was entered. Bookkeeping only — nothing legal should ever be calculated from it.';

/* The agreement cannot commence before it exists in any meaningful sense, but
   it very often commences before it is signed, and that is normal — somebody
   signs on the 20th for a tenancy starting the 1st of the following month.
   
   What is not normal is a commencement date years from the entry, which is
   almost always a typo in the year. */
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_start_sane;
ALTER TABLE leases ADD CONSTRAINT leases_start_sane
  CHECK (start_date > DATE '2020-01-01' AND start_date < DATE '2040-01-01');

/* An increase cannot predate the tenancy. */
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_increase_after_start;
ALTER TABLE leases ADD CONSTRAINT leases_increase_after_start
  CHECK (last_increase_at IS NULL OR last_increase_at >= start_date);

/* Rebuilt against DATE. Same definitions, no time component anywhere. */
CREATE OR REPLACE VIEW rent_increase_eligibility AS
SELECT
  l.id                AS lease_id,
  l.unit_number,
  l.rent              AS current_rent,
  l.term_type,
  l.start_date,
  l.last_increase_at,
  -- The anniversary. From the last increase if there has been one, otherwise
  -- from commencement — both as written on paper.
  COALESCE(l.last_increase_at, l.start_date) AS anniversary_of,
  (CURRENT_DATE - COALESCE(l.last_increase_at, l.start_date)) AS days_since,
  (COALESCE(l.last_increase_at, l.start_date) + 365) AS eligible_from,
  -- Serving can begin the notice period before that.
  (COALESCE(l.last_increase_at, l.start_date) + 365 - 90) AS can_serve_from,
  (COALESCE(l.last_increase_at, l.start_date) + 365 <= CURRENT_DATE) AS eligible_now,
  -- A fixed term cannot be increased mid-term: the rent is what the agreement
  -- says until the agreement ends, and the new figure goes in the renewal.
  (l.term_type = 'periodic') AS can_be_increased,
  EXISTS (SELECT 1 FROM rent_increases ri
          WHERE ri.lease_id = l.id AND ri.state IN ('draft','served'))
    AS has_live_notice
FROM leases l
WHERE l.status = 'active';

CREATE OR REPLACE VIEW active_tenancies AS
SELECT
  l.id                AS lease_id,
  l.unit_number,
  l.term_type,
  l.start_date,
  l.end_date,
  l.rent,
  l.last_increase_at,
  (l.end_date IS NULL) AS is_periodic,
  CASE WHEN l.end_date IS NULL THEN NULL
       ELSE (l.end_date - CURRENT_DATE) END AS days_remaining,
  (CURRENT_DATE - COALESCE(l.last_increase_at, l.start_date)) AS days_since_increase,
  (COALESCE(l.last_increase_at, l.start_date) + 365 <= CURRENT_DATE)
    AS increase_permitted,
  (SELECT COUNT(*) FROM charge_schedules cs
    WHERE cs.lease_id = l.id AND cs.is_active) AS schedule_count,
  -- Anything above zero is somebody living in a suite that is not being
  -- billed for it.
  (SELECT COUNT(*) FROM charge_schedules cs
    WHERE cs.lease_id = l.id AND cs.is_active
      AND cs.end_date IS NOT NULL AND cs.end_date < CURRENT_DATE)
    AS schedules_stopped
FROM leases l
WHERE l.status = 'active';

COMMIT;
