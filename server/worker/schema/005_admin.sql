-- ============================================================
-- Baydo Pointe — the first account
--
-- One Admin, so somebody can get in and invite the rest. The
-- other three are created from the console, not seeded, because
-- an account nobody has claimed is an account with a password
-- somebody wrote down.
--
-- ┌──────────────────────────────────────────────────────────┐
-- │  admin@themizar.ca                                       │
-- │  BaydoPointe2026!Admin                                 │
-- └──────────────────────────────────────────────────────────┘
--
-- This password is in a file, in a repository, in a chat log.
-- Treat it as known to everybody. It is flagged
-- must_change_password, so the console will not do anything until
-- it is changed, but that is a prompt rather than a lock — change
-- it the first time you sign in and this row stops mattering.
--
-- The hash is PBKDF2-SHA512 at 600,000 rounds, which is what
-- worker/src/lib/crypto.js produces. Argon2id would be better and
-- does not run on Workers: it is a native module and there is no
-- flag for that.
-- ============================================================

BEGIN;

INSERT INTO users (
  id, email, full_name, phone, role_code, locale,
  password_algo, password_salt, password_hash, password_params,
  password_changed_at, password_expires_at,
  must_change_password, email_verified_at, is_active
) VALUES (
  'usr_admin000001',
  'admin@themizar.ca',
  'Admin',
  '306-974-1727',
  'admin',
  'en',
  'pbkdf2-sha512',
  '83f061a24f3db45d6b995c2f20adc219',
  '65a00af6c8a7c272feeb86a9b171a9a057979bc1194374f02ad91f421d9a28d630f717af922d9ca586e4f7558066e7e3f03e53f302aa52c0990bf66999825d9c',
  '{"iterations":600000,"hash":"SHA-512","keyLength":64}',
  now(),
  now() + INTERVAL '182 days',
  TRUE,
  now(),
  TRUE
)
ON CONFLICT (email) DO UPDATE SET
  password_algo   = EXCLUDED.password_algo,
  password_salt   = EXCLUDED.password_salt,
  password_hash   = EXCLUDED.password_hash,
  password_params = EXCLUDED.password_params,
  role_code       = 'admin',
  is_active       = TRUE;

-- Admin holds every permission. Not a list maintained by hand: anything added
-- to the permissions table later is included the next time this runs, so a new
-- permission cannot end up with nobody able to grant it.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

COMMIT;

-- After signing in, change the password and then invite the other three from
-- Admin → Accounts. Each of them chooses their own; nobody is sent one.
