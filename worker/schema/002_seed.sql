-- ============================================================
-- Baydo Pointe — seed
--
-- Roles, permissions, buildings and the 330 units. Safe to run
-- twice: everything is ON CONFLICT DO NOTHING, so a re-run after a
-- partial failure adds what is missing rather than erroring.
--
-- The four accounts are created without passwords. Nobody is sent
-- a password by email; each person sets their own from a reset
-- link, and an account with no hash cannot be signed into at all.
-- ============================================================

-- The roles table carries one name. The bilingual labels live in the front
-- end, where they belong: a role's name is an identifier here and a piece of
-- interface there.
INSERT INTO roles (code, name) VALUES
  ('admin', 'Admin'),
  ('property_manager', 'Property Manager'),
  ('building_manager', 'Building Manager'),
  ('accounting', 'Accounting')
ON CONFLICT (code) DO NOTHING;

INSERT INTO buildings (id, code, name, address, storeys, unit_count) VALUES
  ('bd_370', '370', 'Baydo Pointe 370', '370 Clareview Station Drive NW', 6, 118),
  ('bd_374', '374', 'Baydo Pointe 374', '374 Clareview Station Drive NW', 6, 94),
  ('bd_378', '378', 'Baydo Pointe 378', '378 Clareview Station Drive NW', 6, 118)
ON CONFLICT (code) DO NOTHING;

-- The four accounts. No password hash: each person sets their own from a
-- reset link. An account with no hash cannot be signed into, which is the
-- right state for one nobody has claimed yet.
INSERT INTO users (id, email, full_name, role_code, phone, is_active,
                   must_change_password) VALUES
  (gen_random_uuid()::text, 'admin@themizar.ca', 'Admin', 'admin', '306-974-1727', TRUE, TRUE),
  (gen_random_uuid()::text, 'bowen.wang@themizar.ca', 'Bowen Wang', 'property_manager', '780-555-0101', TRUE, TRUE),
  (gen_random_uuid()::text, 'rentals@themizar.ca', 'Rentals', 'building_manager', '780-555-0102', TRUE, TRUE),
  (gen_random_uuid()::text, 'invoice@themizar.ca', 'Accounting', 'accounting', '780-555-0103', TRUE, TRUE)
ON CONFLICT (email) DO NOTHING;

