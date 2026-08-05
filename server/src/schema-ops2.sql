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
