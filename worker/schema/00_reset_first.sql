-- ═══════════════════════════════════════════════════════════════════════
--   Run this first, then the main file.
--
--   Earlier attempts left tables behind. CREATE TABLE IF NOT EXISTS does
--   nothing when the table is already there, so corrected column types
--   never applied and every INSERT went on hitting the old definition.
--   That is why fixing the file kept not helping — the file was right and
--   the database was stale.
--
--   Extensions are dropped explicitly rather than left to the schema drop.
--   DROP SCHEMA public CASCADE removes an extension installed in public
--   but leaves its row in pg_extension, so the next CREATE EXTENSION IF
--   NOT EXISTS does nothing while the type is actually gone. Postgres then
--   reports "type citext does not exist" for something it believes is
--   installed.
--
--   Supabase's own schemas — auth, storage, realtime — are untouched.
--   Nothing in public has completed a run, so there is nothing to keep.
-- ═══════════════════════════════════════════════════════════════════════

DROP EXTENSION IF EXISTS citext CASCADE;
DROP EXTENSION IF EXISTS pgcrypto CASCADE;

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;

-- Both should be zero.
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = 'public')                       AS tables_left,
  (SELECT COUNT(*) FROM pg_extension
    WHERE extname IN ('citext', 'pgcrypto'))             AS extensions_left;

