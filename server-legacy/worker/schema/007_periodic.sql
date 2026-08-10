-- ============================================================
-- Baydo Pointe — periodic tenancies
--
-- A month-to-month lease has no end date, and that one NULL has
-- consequences in four other places. Three of them fail silently.
-- ============================================================

BEGIN;

-- A periodic tenancy has no end date; a fixed term must have one. Written as
-- a constraint because the two are mutually exclusive and the code that sets
-- them is in more than one file.
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_term_consistent;
ALTER TABLE leases ADD CONSTRAINT leases_term_consistent
  CHECK (
    (term_type = 'periodic' AND end_date IS NULL)
    OR (term_type <> 'periodic' AND end_date IS NOT NULL)
    OR status <> 'active'
  );

/* The schedule must not outlive the tenancy it belongs to.
   
   This is the one that costs money. A charge schedule whose end date has
   passed while the lease is still active raises nothing and reports nothing:
   arrears stays clean because no charge was made, the tenant does not
   complain because no invoice arrived, and one suite out of 330 does not move
   the monthly total enough to notice.
   
   A trigger rather than a scheduled check, because the moment to catch it is
   the moment somebody tries to save it. */
CREATE OR REPLACE FUNCTION check_schedule_matches_lease() RETURNS TRIGGER AS $$
DECLARE
  lease_end    DATE;
  lease_status TEXT;
BEGIN
  IF NEW.lease_id IS NULL OR NOT NEW.is_active THEN
    RETURN NEW;
  END IF;

  SELECT end_date, status INTO lease_end, lease_status
  FROM leases WHERE id = NEW.lease_id;

  IF lease_status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- The tenancy has no end, so neither can the schedule.
  IF lease_end IS NULL AND NEW.end_date IS NOT NULL THEN
    RAISE EXCEPTION
      'This tenancy is periodic and has no end date, so the % schedule cannot end on % — it would stop billing while the tenant is still living there.',
      NEW.kind, NEW.end_date;
  END IF;

  -- The schedule stopping before the tenancy does is the same failure with a
  -- date on it.
  IF lease_end IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date < lease_end THEN
    RAISE EXCEPTION
      'The % schedule ends on % but the tenancy runs to %. Rent would stop being billed for the difference.',
      NEW.kind, NEW.end_date, lease_end;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_schedule_matches_lease ON charge_schedules;
CREATE TRIGGER trg_schedule_matches_lease
  BEFORE INSERT OR UPDATE ON charge_schedules
  FOR EACH ROW EXECUTE FUNCTION check_schedule_matches_lease();

/* What is billing and what is not.
   
   A view rather than a report, so the same definition answers the dashboard,
   the month-end checklist and anybody asking in the SQL editor. */
CREATE OR REPLACE VIEW active_tenancies AS
SELECT
  l.id                AS lease_id,
  l.unit_number,
  l.term_type,
  l.end_date,
  l.rent,
  l.last_increase_at,
  (l.end_date IS NULL) AS is_periodic,
  CASE WHEN l.end_date IS NULL THEN NULL
       ELSE (l.end_date - CURRENT_DATE) END AS days_remaining,
  CASE WHEN l.last_increase_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - l.last_increase_at) END AS days_since_increase,
  -- Whether rent can legally be raised. Confirm the interval before relying
  -- on it: it is a legal figure, not a preference.
  (l.last_increase_at IS NULL
   OR l.last_increase_at <= CURRENT_DATE - INTERVAL '365 days') AS increase_permitted,
  (SELECT COUNT(*) FROM charge_schedules cs
    WHERE cs.lease_id = l.id AND cs.is_active) AS schedule_count,
  -- The number worth watching. Anything above zero is a tenancy where
  -- somebody is living in a suite that is not being billed for it.
  (SELECT COUNT(*) FROM charge_schedules cs
    WHERE cs.lease_id = l.id AND cs.is_active
      AND cs.end_date IS NOT NULL AND cs.end_date < CURRENT_DATE)
    AS schedules_stopped
FROM leases l
WHERE l.status = 'active';

COMMIT;
