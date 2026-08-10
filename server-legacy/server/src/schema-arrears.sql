-- ============================================================
-- Baydo Pointe — arrears history and the evidence behind it
--
-- Every demand for rent is recorded here, not only queued as a
-- message. Those are different things: a message queue answers
-- "did we send it", and an application to end a tenancy needs
-- "what was owed, what was demanded, when, and how it reached
-- them".
--
-- Alberta's rules on service and notice periods are specific, and
-- an application usually fails on service or on the notice itself
-- rather than on the debt. So this holds the record; the notice
-- form is uploaded and approved like any other agreement, because
-- a notice with the wrong wording fails whatever the arrears show.
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS arrears_files (
  id            TEXT PRIMARY KEY,
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  lease_id      TEXT REFERENCES leases(id),
  contact_id    TEXT REFERENCES contacts(id),
  tenant_name   TEXT NOT NULL,

  opened_on     TEXT NOT NULL,
  opening_owed  REAL NOT NULL,
  current_owed  REAL NOT NULL,
  peak_owed     REAL,

  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','arrangement','cleared','notice_served','ended','written_off')),
  -- A payment arrangement changes what a later application can rely on:
  -- a tenant keeping to an agreed schedule is not in the same position as
  -- one who has not answered.
  arrangement_note TEXT,
  arrangement_from TEXT,
  cleared_on    TEXT,
  closed_reason TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_number, opened_on)
);
CREATE INDEX IF NOT EXISTS idx_arrears_state ON arrears_files(state, current_owed DESC);

-- One row per demand. This is the spine of an application: what was owed at
-- that moment, what was asked for, and how it was delivered.
CREATE TABLE IF NOT EXISTS arrears_steps (
  id            TEXT PRIMARY KEY,
  file_id       TEXT NOT NULL REFERENCES arrears_files(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  step          TEXT NOT NULL,              -- reminder | request | direct | notice | filing
  owed_at_time  REAL NOT NULL,
  charges_cited TEXT,                       -- JSON: which charges made up the figure
  subject       TEXT,
  body          TEXT NOT NULL,

  -- Service. Alberta has rules about what counts and when it is deemed
  -- received, and an application fails on this more often than on the debt.
  method        TEXT NOT NULL CHECK (method IN
                  ('email','sms','post','personal','posted_on_door','courier')),
  served_on     TEXT NOT NULL,
  deemed_served_on TEXT,
  served_by     TEXT,
  witness       TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'queued'
                CHECK (delivery_state IN ('queued','sent','delivered','bounced','unknown')),
  provider_id   TEXT,
  outbox_id     TEXT REFERENCES outbox(id),

  -- Photographs of a notice on a door, a courier receipt, a delivery report.
  evidence_key  TEXT,
  evidence_sha256 TEXT,

  tenant_response TEXT,
  responded_at  TEXT,
  drafted_by_ai INTEGER NOT NULL DEFAULT 0,
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_astep_file ON arrears_steps(file_id, seq);

-- Payments received while the file is open, so the running figure in the
-- history is the figure that was true on the day of each demand.
CREATE TABLE IF NOT EXISTS arrears_payments (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES arrears_files(id) ON DELETE CASCADE,
  receipt_id  TEXT REFERENCES ar_receipts(id),
  amount      REAL NOT NULL,
  received_on TEXT NOT NULL,
  owed_after  REAL NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Exports of the file, because handing a bundle to a lawyer or filing it is
-- itself an event, and the hash says which version was handed over.
CREATE TABLE IF NOT EXISTS arrears_exports (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES arrears_files(id),
  purpose     TEXT,                         -- rtdrs | lawyer | internal | tenant
  step_count  INTEGER,
  owed_at_export REAL,
  sha256      TEXT,
  exported_by TEXT REFERENCES users(id),
  exported_name TEXT,
  exported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
