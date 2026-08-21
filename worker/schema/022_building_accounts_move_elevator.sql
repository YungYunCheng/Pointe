-- Three legally and operationally separate property accounts per building:
-- one operating rent account and one security-deposit trust account.
-- Also adds tenant-requested move-in / move-out elevator reservations.

INSERT INTO gl_accounts
  (code, name_en, name_zh, type, parent_code, normal_side, is_postable, is_trust, is_bank, note)
VALUES
  ('1010-370', '370 rent operating account', '370 租金營運帳戶', 'asset', '1000', 'debit', TRUE, FALSE, TRUE, 'Rent and other operating receipts for building 370 only.'),
  ('1020-370', '370 deposit trust account', '370 保證金信託帳戶', 'asset', '1000', 'debit', TRUE, TRUE, TRUE, 'Security deposits for building 370 only; never revenue.'),
  ('1010-374', '374 rent operating account', '374 租金營運帳戶', 'asset', '1000', 'debit', TRUE, FALSE, TRUE, 'Rent and other operating receipts for building 374 only.'),
  ('1020-374', '374 deposit trust account', '374 保證金信託帳戶', 'asset', '1000', 'debit', TRUE, TRUE, TRUE, 'Security deposits for building 374 only; never revenue.'),
  ('1010-378', '378 rent operating account', '378 租金營運帳戶', 'asset', '1000', 'debit', TRUE, FALSE, TRUE, 'Rent and other operating receipts for building 378 only.'),
  ('1020-378', '378 deposit trust account', '378 保證金信託帳戶', 'asset', '1000', 'debit', TRUE, TRUE, TRUE, 'Security deposits for building 378 only; never revenue.')
ON CONFLICT (code) DO UPDATE SET
  name_en = EXCLUDED.name_en, name_zh = EXCLUDED.name_zh,
  is_trust = EXCLUDED.is_trust, is_bank = EXCLUDED.is_bank, note = EXCLUDED.note;

CREATE TABLE IF NOT EXISTS building_accounts (
  building_code TEXT NOT NULL REFERENCES buildings(code),
  account_kind TEXT NOT NULL CHECK (account_kind IN ('rent','deposit')),
  gl_code TEXT NOT NULL UNIQUE REFERENCES gl_accounts(code),
  label TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (building_code, account_kind)
);

INSERT INTO building_accounts (building_code, account_kind, gl_code, label) VALUES
  ('370', 'rent', '1010-370', 'Rent account'),
  ('370', 'deposit', '1020-370', 'Deposit trust account'),
  ('374', 'rent', '1010-374', 'Rent account'),
  ('374', 'deposit', '1020-374', 'Deposit trust account'),
  ('378', 'rent', '1010-378', 'Rent account'),
  ('378', 'deposit', '1020-378', 'Deposit trust account')
ON CONFLICT (building_code, account_kind) DO UPDATE SET
  gl_code = EXCLUDED.gl_code, label = EXCLUDED.label, is_active = TRUE;

-- Existing dashboard reconciliation continues to work while including the
-- three new deposit trust accounts. The second view is the building-by-building
-- control used for the three independent monthly reports.
CREATE OR REPLACE VIEW trust_reconciliation AS
SELECT
  COALESCE((SELECT SUM(jl.debit) - SUM(jl.credit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE (jl.gl_code = '1020' OR jl.gl_code LIKE '1020-%') AND je.state = 'posted'), 0) AS trust_bank,
  COALESCE((SELECT SUM(jl.credit) - SUM(jl.debit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'), 0) AS deposit_liability,
  COALESCE((SELECT SUM(jl.debit) - SUM(jl.credit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE (jl.gl_code = '1020' OR jl.gl_code LIKE '1020-%') AND je.state = 'posted'), 0)
  - COALESCE((SELECT SUM(jl.credit) - SUM(jl.debit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'), 0) AS difference;

CREATE OR REPLACE VIEW building_trust_reconciliation AS
SELECT b.code AS building_code,
  COALESCE((SELECT SUM(jl.debit - jl.credit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code = '1020-' || b.code AND je.state = 'posted'), 0) AS trust_bank,
  COALESCE((SELECT SUM(jl.credit - jl.debit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'
      AND COALESCE(jl.building_code, je.building_code) = b.code), 0) AS deposit_liability,
  COALESCE((SELECT SUM(jl.debit - jl.credit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code = '1020-' || b.code AND je.state = 'posted'), 0)
  - COALESCE((SELECT SUM(jl.credit - jl.debit)
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'
      AND COALESCE(jl.building_code, je.building_code) = b.code), 0) AS difference
FROM buildings b
WHERE b.code IN ('370','374','378');

CREATE TABLE IF NOT EXISTS move_elevator_bookings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES tenant_accounts(id),
  lease_id TEXT REFERENCES leases(id),
  unit_number TEXT NOT NULL REFERENCES units(unit_number),
  building_code TEXT NOT NULL REFERENCES buildings(code),
  direction TEXT NOT NULL CHECK (direction IN ('move_in','move_out')),
  move_date DATE NOT NULL,
  time_from TIME NOT NULL,
  time_to TIME NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','confirmed','declined','cancelled','completed')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_name TEXT,
  confirmed_at TIMESTAMPTZ,
  decision_note TEXT,
  tenant_notified_at TIMESTAMPTZ,
  morning_reminder_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (time_to > time_from)
);
CREATE INDEX IF NOT EXISTS idx_move_elevator_date
  ON move_elevator_bookings(building_code, move_date, time_from)
  WHERE status IN ('requested','confirmed');
CREATE INDEX IF NOT EXISTS idx_move_elevator_tenant
  ON move_elevator_bookings(account_id, move_date DESC);

INSERT INTO permissions (code, description) VALUES
  ('move_booking.view', 'View tenant move-in and move-out elevator bookings'),
  ('move_booking.confirm', 'Confirm or decline tenant elevator bookings')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('property_manager', 'move_booking.view'),
  ('building_manager', 'move_booking.view'),
  ('building_manager', 'move_booking.confirm')
ON CONFLICT DO NOTHING;
