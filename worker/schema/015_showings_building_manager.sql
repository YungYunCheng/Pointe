BEGIN;

/* Showings are performed and closed out by the on-site Building Manager.
 * Keep PM access for leasing/signing work, but remove showing actions. */
DELETE FROM role_permissions
WHERE role_code = 'property_manager'
  AND permission_code IN ('showings.manage', 'schedule.showings');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('admin', 'showings.manage'),
  ('admin', 'schedule.showings'),
  ('building_manager', 'showings.manage'),
  ('building_manager', 'schedule.showings')
ON CONFLICT DO NOTHING;

/* Repair existing showings created while the API used the creator as owner.
 * With the current single-BM setup this resolves to the Rentals/BM account. */
WITH preferred_bm AS (
  SELECT id, full_name
  FROM users
  WHERE role_code = 'building_manager' AND is_active
  ORDER BY full_name, id
  LIMIT 1
)
UPDATE events AS e
SET assignee_id = preferred_bm.id,
    assignee = preferred_bm.full_name
FROM preferred_bm
WHERE e.type = 'showing'
  AND (
    e.assignee_id IS DISTINCT FROM preferred_bm.id
    OR e.assignee IS DISTINCT FROM preferred_bm.full_name
  );

COMMIT;
