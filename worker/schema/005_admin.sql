-- Baydo Pointe — first admin authorization
--
-- The seed creates admin@themizar.ca without a password hash. The account
-- cannot sign in until the owner uses Forgot password and follows the
-- one-time link. No reusable bootstrap password belongs in source control.

BEGIN;

UPDATE users
SET role_code = 'admin', is_active = TRUE, must_change_password = TRUE
WHERE lower(email) = 'admin@themizar.ca';

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

COMMIT;
