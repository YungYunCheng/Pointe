-- ============================================================
-- Baydo Pointe — per-user permissions, purchase orders,
-- receipts, escalation, retention
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Per-user permission grants ----------
-- The role is the baseline. This layers on top, so Admin can give one person
-- one extra thing without inventing a fifth role for them.
CREATE TABLE IF NOT EXISTS user_permissions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL REFERENCES permissions(code),
  effect      TEXT NOT NULL CHECK (effect IN ('grant','revoke')),
  reason      TEXT,
  granted_by  TEXT REFERENCES users(id),
  granted_name TEXT,
  granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  UNIQUE (user_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_uperm_user ON user_permissions(user_id);

-- ---------- Purchase orders ----------
-- A PO is a commitment, not a liability. It does not touch the ledger.
-- It becomes a bill when the work is done and the amount is confirmed —
-- and the amount usually changes, which is the whole reason for the two
-- steps rather than one.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  po_number     TEXT NOT NULL UNIQUE,
  ticket_id     TEXT REFERENCES maintenance(id),
  vendor_id     TEXT REFERENCES vendors(id),
  vendor_name   TEXT,
  unit_number   TEXT,
  building_code TEXT REFERENCES buildings(code),
  description   TEXT NOT NULL,
  scope         TEXT,                       -- what the vendor is being asked to do
  gl_code       TEXT REFERENCES gl_accounts(code),
  estimated     REAL NOT NULL,
  scheduled_at  TEXT,
  drafted_by_ai INTEGER NOT NULL DEFAULT 0,
  ai_model      TEXT,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','issued','work_done','billed','cancelled')),
  -- The actual, entered by whoever was on site. Blank until the work is done.
  actual_amount REAL,
  variance_note TEXT,                       -- required when actual differs from estimate
  confirmed_by  TEXT REFERENCES users(id),
  confirmed_name TEXT,
  confirmed_at  TEXT,
  bill_id       TEXT REFERENCES ap_invoices(id),
  cancelled_reason TEXT,
  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_po_state ON purchase_orders(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_ticket ON purchase_orders(ticket_id);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id          TEXT PRIMARY KEY,
  po_id       TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  description TEXT NOT NULL,
  gl_code     TEXT REFERENCES gl_accounts(code),
  quantity    REAL DEFAULT 1,
  unit_price  REAL,
  estimated   REAL NOT NULL,
  actual      REAL
);
CREATE INDEX IF NOT EXISTS idx_pol_po ON purchase_order_lines(po_id);

-- ---------- Receipts to tenants ----------
-- Issued by Accounting after the money is confirmed, never on the promise of
-- money. A receipt for a payment that later bounces is worse than no receipt.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id            TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  ar_receipt_id TEXT NOT NULL REFERENCES ar_receipts(id),
  unit_number   TEXT,
  tenant_name   TEXT,
  tenant_email  TEXT,
  tenant_phone  TEXT,
  amount        REAL NOT NULL,
  received_date TEXT NOT NULL,
  method        TEXT,
  applied_to    TEXT,                       -- JSON: which charges it settled
  balance_after REAL,
  locale        TEXT DEFAULT 'en',
  outbox_id     TEXT REFERENCES outbox(id),
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','sent','failed')),
  confirmed_by  TEXT REFERENCES users(id),
  confirmed_name TEXT,
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prcpt_state ON payment_receipts(state);

-- ---------- Escalation ----------
-- Handing a message to a person is not the same as a person seeing it. This
-- turns an escalation into an email with a reply link and a clock, so a
-- tenant is not waiting on somebody happening to open a console.
CREATE TABLE IF NOT EXISTS escalations (
  id            TEXT PRIMARY KEY,
  message_id    TEXT,
  source        TEXT NOT NULL,              -- inbox | tenant_chat | portal
  rule_id       TEXT,                       -- R-101 … the reason it was intercepted
  topic         TEXT,
  tenant_name   TEXT,
  tenant_email  TEXT,
  tenant_phone  TEXT,
  unit_number   TEXT,
  locale        TEXT DEFAULT 'en',
  -- Content is not copied for the protected-ground rules. The person opens
  -- the thread to read it; the escalation record holds the rule id only.
  body_included INTEGER NOT NULL DEFAULT 1,
  body          TEXT,
  assigned_role TEXT NOT NULL DEFAULT 'property_manager',
  assigned_to   TEXT REFERENCES users(id),
  outbox_id     TEXT REFERENCES outbox(id),
  reply_token   TEXT UNIQUE,
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','claimed','answered','closed')),
  claimed_by    TEXT REFERENCES users(id),
  claimed_name  TEXT,
  claimed_at    TEXT,
  answered_at   TEXT,
  answer_body   TEXT,
  due_by        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_esc_state ON escalations(state, due_by);

-- ---------- Key handover gate ----------
-- Keys cannot be booked until the lease is signed and the Property Manager
-- has confirmed it. Handing over keys against an unsigned lease gives away
-- possession with nothing to enforce.
CREATE TABLE IF NOT EXISTS key_release_approvals (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  lease_id     TEXT REFERENCES leases(id),
  issue_id     TEXT REFERENCES agreement_issues(id),
  tenant_name  TEXT,
  deposit_received INTEGER NOT NULL DEFAULT 0,
  first_rent_received INTEGER NOT NULL DEFAULT 0,
  lease_signed INTEGER NOT NULL DEFAULT 0,
  approved_by  TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at  TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_number, lease_id)
);

-- ---------- Shadow mode ----------
-- The AI runs the whole way through and nothing is sent. Two to four weeks
-- of this before going live is how you find out the error rate instead of
-- guessing it — and the errors that matter are the ones nobody would have
-- caught by reading a few samples.
CREATE TABLE IF NOT EXISTS shadow_runs (
  id            TEXT PRIMARY KEY,
  message_id    TEXT,
  source        TEXT,
  intent        TEXT,
  confidence    REAL,
  level         TEXT,                       -- what it would have done
  rule_id       TEXT,
  draft         TEXT,
  facts_used    TEXT,
  would_send    INTEGER NOT NULL DEFAULT 0,
  -- Filled by a person afterwards. Without this the run is a pile of drafts
  -- nobody scored, which measures nothing.
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_name TEXT,
  verdict       TEXT CHECK (verdict IN ('correct','wrong_intent','wrong_content','should_not_send','missed_stop')),
  reviewer_note TEXT,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shadow_verdict ON shadow_runs(verdict, created_at DESC);

-- ---------- Turnover ----------
-- Between a tenant leaving and the unit being back on the market is pure
-- vacancy loss, and it is the number nobody measures because no single
-- person owns it.
CREATE TABLE IF NOT EXISTS turnovers (
  id             TEXT PRIMARY KEY,
  unit_number    TEXT NOT NULL REFERENCES units(unit_number),
  moveout_id     TEXT REFERENCES moveouts(id),
  vacated_at     TEXT NOT NULL,
  inspected_at   TEXT,
  work_started_at TEXT,
  work_done_at   TEXT,
  listed_at      TEXT,
  leased_at      TEXT,
  occupied_at    TEXT,
  daily_rent     REAL,
  cost_total     REAL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'vacant'
                 CHECK (state IN ('vacant','inspecting','working','listed','leased','occupied')),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turnover_state ON turnovers(state, vacated_at);

CREATE TABLE IF NOT EXISTS turnover_tasks (
  id          TEXT PRIMARY KEY,
  turnover_id TEXT NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  ticket_id   TEXT REFERENCES maintenance(id),
  po_id       TEXT REFERENCES purchase_orders(id),
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  done_by     TEXT
);

-- ---------- Pricing signals ----------
-- A unit shown twelve times without an application is telling you something.
CREATE TABLE IF NOT EXISTS pricing_signals (
  id            TEXT PRIMARY KEY,
  unit_type     TEXT NOT NULL,
  period        TEXT NOT NULL,
  showings      INTEGER NOT NULL DEFAULT 0,
  applications  INTEGER NOT NULL DEFAULT 0,
  not_interested INTEGER NOT NULL DEFAULT 0,
  price_reason  INTEGER NOT NULL DEFAULT 0, -- said no because of price
  avg_days_vacant REAL,
  current_rent  REAL,
  computed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_type, period)
);

-- ---------- GST ----------
CREATE TABLE IF NOT EXISTS gst_returns (
  id            TEXT PRIMARY KEY,
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  collected     REAL NOT NULL DEFAULT 0,    -- 2300, GST charged out
  input_credits REAL NOT NULL DEFAULT 0,    -- 1210, GST paid on purchases
  net           REAL NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','filed','paid')),
  filed_at      TEXT,
  filed_by      TEXT REFERENCES users(id),
  confirmation  TEXT,
  entry_id      TEXT REFERENCES journal_entries(id),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period_from, period_to)
);

-- ---------- Fixed assets ----------
CREATE TABLE IF NOT EXISTS fixed_assets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  building_code  TEXT REFERENCES buildings(code),
  asset_class    TEXT,                      -- CCA class, e.g. 1 for buildings
  cost           REAL NOT NULL,
  in_service_on  TEXT NOT NULL,
  useful_life_years REAL,
  method         TEXT NOT NULL DEFAULT 'straight_line'
                 CHECK (method IN ('straight_line','declining_balance')),
  rate           REAL,                      -- for declining balance
  salvage        REAL DEFAULT 0,
  asset_gl       TEXT DEFAULT '1500',
  accum_gl       TEXT DEFAULT '1510',
  expense_gl     TEXT DEFAULT '5200',
  disposed_on    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS depreciation_runs (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES fixed_assets(id),
  period     TEXT NOT NULL,
  amount     REAL NOT NULL,
  entry_id   TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, period)
);

-- ---------- Owner statements ----------
CREATE TABLE IF NOT EXISTS owner_statements (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  figures       TEXT NOT NULL,
  method        TEXT NOT NULL,
  distribution  REAL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','final','sent')),
  entry_id      TEXT REFERENCES journal_entries(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period, building_code)
);
