-- Legacy reference only — no reusable bootstrap password is stored.

BEGIN;

UPDATE users
SET role_code = 'admin', is_active = TRUE, must_change_password = TRUE
WHERE lower(email) = 'admin@themizar.ca';

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

COMMIT;
