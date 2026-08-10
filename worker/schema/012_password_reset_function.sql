BEGIN;

/*
 * Older Pointe databases predate these password-metadata columns. PL/pgSQL
 * defers column resolution until a function is called, so CREATE FUNCTION can
 * otherwise succeed here and the reset endpoint fail later with HTTP 500.
 */
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_params TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_expires_at TIMESTAMPTZ;

ALTER TABLE password_history
  ADD COLUMN IF NOT EXISTS params TEXT;

/*
 * Keep the complete password-reset transaction inside PostgreSQL.
 *
 * Cloudflare Workers Free allows very little CPU per request. Even when the
 * expensive bcrypt operation runs in pgcrypto, constructing and parsing the
 * previous multi-CTE statement at the edge can exceed that budget. The Worker
 * now sends one small function call; token locking, history checks, hashing,
 * password replacement and session revocation all remain atomic here.
 */
CREATE OR REPLACE FUNCTION public.reset_staff_password(
  p_token_hash          TEXT,
  p_password            TEXT,
  p_history_id          TEXT,
  p_password_params     TEXT,
  p_password_expires_at TIMESTAMPTZ,
  p_history_limit      INTEGER DEFAULT 5
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO public, extensions
AS $$
DECLARE
  v_token password_reset_tokens%ROWTYPE;
  v_user users%ROWTYPE;
  v_reused BOOLEAN := FALSE;
  v_hash TEXT;
BEGIN
  SELECT p.*
    INTO v_token
    FROM password_reset_tokens p
   WHERE p.token_hash = p_token_hash
   ORDER BY p.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_token.used_at IS NOT NULL THEN
    RETURN 'INVALID_TOKEN';
  END IF;
  IF v_token.expires_at <= now() THEN
    RETURN 'TOKEN_EXPIRED';
  END IF;

  SELECT u.*
    INTO v_user
    FROM users u
   WHERE u.id = v_token.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'INVALID_TOKEN';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT h.hash
          FROM password_history h
         WHERE h.user_id = v_user.id
           AND h.algo = 'bcrypt-pgcrypto'
         ORDER BY h.changed_at DESC
         LIMIT GREATEST(p_history_limit, 0)
      ) recent
     WHERE extensions.crypt(p_password, recent.hash) = recent.hash
  ) INTO v_reused;

  IF v_reused THEN
    RETURN 'PASSWORD_RECENTLY_USED';
  END IF;

  v_hash := extensions.crypt(
    p_password,
    extensions.gen_salt('bf', 12)
  );

  UPDATE password_reset_tokens
     SET used_at = now()
   WHERE id = v_token.id;

  IF v_user.password_hash IS NOT NULL THEN
    INSERT INTO password_history (id, user_id, hash, salt, algo, params)
    VALUES (
      p_history_id,
      v_user.id,
      v_user.password_hash,
      COALESCE(v_user.password_salt, ''),
      v_user.password_algo,
      v_user.password_params
    );
  END IF;

  UPDATE users
     SET password_algo = 'bcrypt-pgcrypto',
         password_salt = '',
         password_hash = v_hash,
         password_params = p_password_params,
         password_changed_at = now(),
         password_expires_at = p_password_expires_at,
         must_change_password = FALSE,
         failed_attempts = 0,
         locked_until = NULL
   WHERE id = v_user.id;

  UPDATE sessions
     SET revoked_at = now()
   WHERE user_id = v_user.id
     AND revoked_at IS NULL;

  RETURN 'OK';
END;
$$;

COMMIT;
