-- ============================================================
-- Baydo Pointe — payments
--
-- Two things decide the shape of this and neither is technical.
--
-- Processing fees. On $1,450 rent, a card costs about $42 and a
-- pre-authorised debit about $12. Across 330 suites that is
-- $168,000 a year against $47,000. Who absorbs it is a decision,
-- and it is recorded per method rather than assumed.
--
-- The trust account. A security deposit is held in trust — 1020
-- bank against 2100 liability — and the dashboard checks the two
-- are equal. A processor that settles everything into one
-- operating account breaks that the moment a deposit goes through
-- it: the liability rises and the trust bank does not. So a
-- deposit either has its own settlement account, or it is
-- transferred and the transfer is recorded.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payment_methods (
  code          TEXT PRIMARY KEY,
  label_en      TEXT NOT NULL,
  label_zh      TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('online','manual')),

  -- What it costs, so the figure is in one place rather than in somebody's
  -- head. Both parts: processors charge a percentage and a flat amount.
  fee_percent   NUMERIC(10,6) NOT NULL DEFAULT 0,
  fee_fixed     NUMERIC(14,2) NOT NULL DEFAULT 0,

  /* Who pays it.
     
     'absorb' means the property takes it as an expense. 'surcharge' means it
     is added to what the tenant pays — legal in Canada for credit cards since
     2022, subject to the card network rules and a cap, and it has to be
     disclosed before payment. Confirm the current rules before turning it on.
     
     Rent is a debt, so a surcharge is not a rent increase and does not need
     notice. It is still a change to what somebody pays and it should not
     appear without warning. */
  fee_borne_by  TEXT NOT NULL DEFAULT 'absorb'
                CHECK (fee_borne_by IN ('absorb','surcharge')),
  surcharge_cap_percent NUMERIC(10,6),

  -- Which ledger account the money lands in. A deposit paid by a method that
  -- settles into operating cash cannot be held in trust, so the method itself
  -- carries the answer.
  settles_to_gl TEXT REFERENCES gl_accounts(code),
  trust_capable BOOLEAN NOT NULL DEFAULT FALSE,

  -- How long until the money is actually there. A payment marked received the
  -- moment it is authorised is a receipt against money that can still be
  -- reversed.
  settlement_days INTEGER NOT NULL DEFAULT 0,
  reversible_days INTEGER NOT NULL DEFAULT 0,

  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 10,
  note          TEXT
);

/* An attempt to pay, from either side.
   
   Online payments and cheques entered by Accounting are the same table on
   purpose. The tenant statement should not care which way the money arrived,
   and a reconciliation that has to look in two places is a reconciliation
   that misses one. */
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  reference     TEXT UNIQUE NOT NULL,

  lease_id      TEXT REFERENCES leases(id),
  unit_number   TEXT REFERENCES units(unit_number),
  account_id    TEXT REFERENCES tenant_accounts(id),
  contact_id    TEXT REFERENCES contacts(id),

  method_code   TEXT NOT NULL REFERENCES payment_methods(code),
  purpose       TEXT NOT NULL DEFAULT 'rent'
                CHECK (purpose IN ('rent','deposit','other')),

  -- What the tenant intended to pay, what the fee was, and what actually
  -- moved. Three numbers because they differ, and a receipt showing only one
  -- of them is a receipt somebody will query.
  amount        NUMERIC(14,2) NOT NULL,
  fee_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_charged NUMERIC(14,2) NOT NULL,

  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','authorised','settled','failed',
                                 'reversed','cancelled')),

  -- From the processor, or from the cheque.
  processor     TEXT,
  processor_ref TEXT,
  cheque_number TEXT,
  bank_name     TEXT,
  received_on   DATE,
  settled_on    DATE,
  failure_code  TEXT,
  failure_note  TEXT,

  -- Where it landed, and the receipt it became.
  settled_to_gl TEXT REFERENCES gl_accounts(code),
  receipt_id    TEXT REFERENCES ar_receipts(id),
  deposit_entry_id TEXT REFERENCES deposit_ledger(id),
  entry_id      TEXT REFERENCES journal_entries(id),

  entered_by    TEXT REFERENCES users(id),
  entered_name  TEXT,
  ip            TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pay_unit ON payments(unit_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_state ON payments(state, created_at DESC);

-- A processor reference is unique when there is one. Two payments with the
-- same reference is a webhook delivered twice, and taking the money twice is
-- worse than dropping it once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_processor_ref
  ON payments(processor, processor_ref)
  WHERE processor_ref IS NOT NULL;

-- The same cheque entered twice by two people on a busy morning.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_cheque
  ON payments(unit_number, cheque_number)
  WHERE cheque_number IS NOT NULL;

/* Which charges a payment settles, and in what order.
   
   This is not arbitrary. Applying a rent payment to a damage charge instead
   of to the rent puts the tenant in arrears on rent, and arrears on rent is
   grounds to end a tenancy where a disputed damage charge is not. Oldest rent
   first unless the tenant said otherwise, and what they said is recorded. */
CREATE TABLE IF NOT EXISTS payment_applications (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  charge_id   TEXT NOT NULL REFERENCES ar_charges(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  directed_by TEXT CHECK (directed_by IN ('tenant','rule','staff')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, charge_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      TEXT,
  actor_name  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* A deposit cannot settle into operating cash.
   
   The trust reconciliation compares 1020 against 2100 plus 2110 and expects
   them equal. A deposit landing in 1010 raises the liability without raising
   the trust bank, and the dashboard goes red with nothing to say why.
   
   Caught here rather than in a nightly check, because by then the money has
   moved. */
CREATE OR REPLACE FUNCTION check_deposit_settles_to_trust() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.purpose <> 'deposit' OR NEW.state NOT IN ('settled','authorised') THEN
    RETURN NEW;
  END IF;

  IF NEW.settled_to_gl IS DISTINCT FROM '1020' THEN
    RAISE EXCEPTION
      'A security deposit has to settle into the trust account (1020), not %. The trust reconciliation compares 1020 against the deposit liability, and money landing anywhere else breaks it silently.',
      COALESCE(NEW.settled_to_gl, 'nothing');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposit_trust ON payments;
CREATE TRIGGER trg_deposit_trust
  BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION check_deposit_settles_to_trust();

/* Applications cannot exceed the payment. */
CREATE OR REPLACE FUNCTION check_application_total() RETURNS TRIGGER AS $$
DECLARE
  applied NUMERIC(14,2);
  paid    NUMERIC(14,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO applied
  FROM payment_applications WHERE payment_id = NEW.payment_id;

  SELECT amount INTO paid FROM payments WHERE id = NEW.payment_id;

  IF applied > paid + 0.005 THEN
    RAISE EXCEPTION
      'Applications total % against a payment of %. The difference would settle charges nobody paid.',
      applied, paid;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_application_total ON payment_applications;
CREATE CONSTRAINT TRIGGER trg_application_total
  AFTER INSERT OR UPDATE ON payment_applications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_application_total();

/* The methods. Fees are current typical Canadian rates and should be checked
   against whatever agreement you actually sign. */
INSERT INTO payment_methods (code, label_en, label_zh, channel, fee_percent, fee_fixed, fee_borne_by,
   settles_to_gl, trust_capable, settlement_days, reversible_days, sort_order, note) VALUES
  ('eft', 'Bank transfer', '銀行轉帳', 'online', 0.008, 0.25, 'absorb',
   '1010', TRUE, 3, 90, 10,
   'Pre-authorised debit. Cheapest online method by a wide margin, and reversible for 90 days — a payment is not final the day it arrives.'),

  ('card', 'Credit or debit card', '信用卡／簽帳卡', 'online', 0.029, 0.30, 'absorb',
   '1010', FALSE, 2, 120, 20,
   'About $42 on a $1,450 rent. Across 330 suites that is roughly $168,000 a year against $47,000 for bank transfer. Not trust-capable: card settlement goes to one account and a deposit needs its own.'),

  ('etransfer', 'Interac e-Transfer', 'Interac 轉帳', 'manual', 0, 1.50, 'absorb',
   '1010', TRUE, 1, 0, 30,
   'Cheap and not reversible once accepted, but it arrives as an email rather than a feed — somebody has to match it to a suite.'),

  ('cheque', 'Cheque', '支票', 'manual', 0, 0, 'absorb',
   '1010', TRUE, 5, 30, 40,
   'No fee, and it can bounce for a month. Entered by Accounting when it arrives, not when it clears.'),

  ('cash', 'Cash', '現金', 'manual', 0, 0, 'absorb', '1010', TRUE, 0, 0, 50, 'Receipted immediately. Two people should count it.'),

  ('deposit_trust', 'Deposit — trust account', '押金專戶', 'online', 0.008, 0.25, 'absorb',
   '1020', TRUE, 3, 90, 5,
   'A separate settlement account for deposits. The trust reconciliation compares 1020 against the deposit liability, so a deposit landing in operating cash breaks it.')
ON CONFLICT (code) DO NOTHING;

COMMIT;
