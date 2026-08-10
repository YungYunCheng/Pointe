BEGIN;

/*
 * Compatibility for databases created before the password-hardening
 * migrations. reset_staff_password() can be created when one of these
 * columns is absent, but PostgreSQL then raises an undefined-column error the
 * first time the function executes.
 *
 * This is idempotent: an up-to-date database has nothing to change.
 */
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_params TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_expires_at TIMESTAMPTZ;

ALTER TABLE password_history
  ADD COLUMN IF NOT EXISTS params TEXT;

COMMIT;
