import { Hono } from "hono";
import { require_, tenantUnit, audit, uid } from "../lib/auth.js";

/* ============================================================
   Payments

   Online and by cheque, in one table. The tenant statement should
   not care which way the money arrived, and a reconciliation that
   has to look in two places is one that misses one.

   The part worth reading carefully is how a payment is applied.
   Putting rent money against a damage charge leaves the tenant in
   arrears on rent, and arrears on rent is grounds to end a tenancy
   where a disputed damage charge is not. So rent is settled first
   unless the tenant said otherwise, and what they said is recorded.
   ============================================================ */

const r = new Hono();

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(Number(n ?? 0));
const ref = () => "PAY-" + crypto.randomUUID().slice(0, 8).toUpperCase();

/* The order charges are settled in.
   
   Rent before anything else, oldest first. A tenant who pays their rent and
   finds it applied to a damage charge they are disputing is now in arrears on
   rent — which is grounds to end a tenancy, where the damage charge is not.
   
   The tenant can direct a payment elsewhere and that direction is recorded,
   because it is their money and their choice. What is not acceptable is
   directing it for them and calling it a rule. */
const SETTLEMENT_ORDER = ["rent", "parking", "storage", "pet", "utilities",
                          "late_fee", "damage", "other"];

const CHARGE_ACCOUNTS = {
  rent: "4010", parking: "4020", storage: "4030", pet: "4040",
  late_fee: "4060", damage: "4070", utilities: "4090", other: "4090",
  adjustment: "4090",
};

/* Ledger writes are deliberately role-bound as well as permission-bound.
 * A one-off permission grant must not accidentally turn a PM/BM session into
 * an accounting posting session. */
const ledgerEditor = async (c, next) => {
  const user = c.get("user");
  if (!["admin", "accounting"].includes(user?.role) ||
      !user?.perms?.has("accounting.ar"))
    return c.json({ code: "FORBIDDEN", needs: "accounting.ar" }, 403);
  return next();
};

function orderCharges(charges) {
  return [...charges].sort((a, b) => {
    const ai = SETTLEMENT_ORDER.indexOf(a.kind);
    const bi = SETTLEMENT_ORDER.indexOf(b.kind);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return String(a.due_date).localeCompare(String(b.due_date));
  });
}

async function leaseBalance(sql, leaseId) {
  if (!leaseId) return { balance: 0, outstanding: 0, prepayment: 0 };
  const [row] = await sql`
    WITH clock AS (
      SELECT (now() AT TIME ZONE 'America/Edmonton')::date AS local_today
    )
    SELECT
      COALESCE((SELECT SUM(c.amount) FROM ar_charges c, clock
        WHERE c.lease_id = ${leaseId} AND c.state <> 'void'
          AND c.charge_date <= clock.local_today), 0)
      - COALESCE((SELECT SUM(p.amount) FROM payments p, clock
        WHERE p.lease_id = ${leaseId} AND p.purpose <> 'deposit'
          AND p.state IN ('authorised','settled')
          AND COALESCE(p.received_on, p.created_at::date) <= clock.local_today), 0)
      AS balance`;
  const balance = cents(row?.balance ?? 0);
  return {
    balance,
    outstanding: Math.max(0, balance),
    prepayment: Math.max(0, cents(-balance)),
  };
}

/* ---------- What a tenant can pay with ---------- */

r.get("/tenant/payment-methods", async (c) => {
  const sql = c.get("db");
  const methods = await sql`SELECT * FROM payment_methods
    WHERE is_active AND channel = 'online' ORDER BY sort_order`;

  return c.json({
    methods: methods.map((m) => ({
      code: m.code, label_en: m.label_en, label_zh: m.label_zh,
      // What it would cost them, if they are the ones paying it. Shown before
      // they choose rather than on the confirmation screen.
      fee_borne_by: m.fee_borne_by,
      fee_percent: Number(m.fee_percent),
      fee_fixed: Number(m.fee_fixed),
      settlement_days: m.settlement_days,
      note: m.note,
    })),
  });
});

/**
 * A tenant paying.
 *
 * The charges are read here rather than trusted from the request, because a
 * client that decides what it owes is a client that can decide it owes less.
 */
r.post("/tenant/pay", async (c) => {
  const sql = c.get("db");
  const unit = tenantUnit(c);
  const t = c.get("tenant");
  const { method_code, amount, purpose = "rent", direct_to } = await c.req.json();

  if (!method_code || !(Number(amount) > 0))
    return c.json({ code: "MISSING_FIELDS" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [method] = await tx`SELECT * FROM payment_methods
        WHERE code = ${method_code} AND is_active AND channel = 'online'`;
      if (!method) throw Object.assign(new Error("METHOD_NOT_AVAILABLE"), { status: 400 });

      // A deposit has to land in trust. The method decides whether it can.
      if (purpose === "deposit" && !method.trust_capable)
        throw Object.assign(new Error("METHOD_NOT_TRUST_CAPABLE"), { status: 400,
          detail: "A deposit has to settle into the trust account, and this method settles into operating cash." });

      const paid = cents(amount);
      const fee = cents(paid * Number(method.fee_percent) + Number(method.fee_fixed));
      // Absorbed by the property, or added to what they pay. Whichever it is,
      // the tenant sees it before they confirm.
      const charged = method.fee_borne_by === "surcharge" ? cents(paid + fee) : paid;

      const [lease] = await tx`SELECT id, contact_id FROM leases
        WHERE unit_number = ${unit} AND status = 'active'`;

      const [p] = await tx`
        INSERT INTO payments (id, reference, lease_id, unit_number, account_id,
          contact_id, method_code, purpose, amount, fee_amount, total_charged,
          state, processor, settled_to_gl, received_on, ip)
        VALUES (${uid("pay_")}, ${ref()}, ${lease?.id ?? null}, ${unit}, ${t.id},
                ${lease?.contact_id ?? null}, ${method_code}, ${purpose},
                ${paid}, ${fee}, ${charged}, 'pending', ${method.channel === "online" ? "stripe" : null},
                ${purpose === "deposit" ? "1020" : method.settles_to_gl},
                ${today()}, ${c.req.header("cf-connecting-ip") ?? null})
        RETURNING *`;

      await tx`INSERT INTO payment_events (id, payment_id, event, detail)
        VALUES (${uid("pe_")}, ${p.id}, 'created',
                ${`${money(paid)} by ${method.label_en}${fee > 0 ? `, fee ${money(fee)}` : ""}`})`;

      return { payment: p, method };
    });

    return c.json({
      payment: { reference: out.payment.reference, amount: out.payment.amount,
                 fee: out.payment.fee_amount, total: out.payment.total_charged,
                 state: out.payment.state },
      // Where the processor would be handed off to. Nothing is charged until
      // the processor is wired — this records the intent.
      next: "processor_handoff",
      note: `Settles in about ${out.method.settlement_days} business day${out.method.settlement_days === 1 ? "" : "s"}.`,
    }, 201);
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

/* ---------- Accounting entering what arrived ---------- */

r.get("/payment-methods/manual", ledgerEditor, async (c) => c.json({
  methods: await c.get("db")`
    SELECT code, label_en, label_zh, trust_capable
    FROM payment_methods
    WHERE is_active AND channel = 'manual'
    ORDER BY sort_order`,
}));

/**
 * A cheque, an e-transfer, cash across the counter.
 *
 * Recorded when it arrives, not when it clears. A cheque can bounce for a
 * month, and a receipt issued the day it was handed over is a receipt against
 * money that may not be there — so it settles rather than being received.
 */
r.post("/payments/manual", ledgerEditor, async (c) => {
  const sql = c.get("db");
  const { unit_number, method_code, amount, purpose = "rent", received_on,
          cheque_number, bank_name, reference: theirRef, note,
          apply_to } = await c.req.json();

  if (!unit_number || !method_code || !(Number(amount) > 0))
    return c.json({ code: "MISSING_FIELDS" }, 400);
  if (method_code === "cheque" && !String(cheque_number ?? "").trim())
    return c.json({ code: "CHEQUE_NUMBER_REQUIRED" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [method] = await tx`SELECT * FROM payment_methods
        WHERE code = ${method_code} AND is_active AND channel = 'manual'`;
      if (!method) throw Object.assign(new Error("UNKNOWN_METHOD"), { status: 400 });

      if (purpose === "deposit" && !method.trust_capable)
        throw Object.assign(new Error("METHOD_NOT_TRUST_CAPABLE"), { status: 400,
          detail: "A deposit has to go into the trust account." });

      const [lease] = await tx`SELECT id, contact_id FROM leases
        WHERE unit_number = ${unit_number} AND status = 'active'`;
      if (!lease && purpose !== "deposit")
        throw Object.assign(new Error("NO_ACTIVE_TENANCY"), { status: 409,
          detail: "Rent cannot be posted to a vacant unit. Assign the resident and active lease first." });

      const paid = cents(amount);
      const on = received_on || today();

      const [p] = await tx`
        INSERT INTO payments (id, reference, lease_id, unit_number, contact_id,
          method_code, purpose, amount, fee_amount, total_charged, state,
          cheque_number, bank_name, processor_ref, received_on,
          settled_to_gl, entered_by, entered_name, note)
        VALUES (${uid("pay_")}, ${ref()}, ${lease?.id ?? null}, ${unit_number},
                ${lease?.contact_id ?? null}, ${method_code}, ${purpose},
                ${paid}, 0, ${paid}, 'authorised',
                ${method_code === "cheque" ? String(cheque_number).trim() : null},
                ${bank_name ?? null}, ${method_code === "cheque" ? null : theirRef ?? null},
                ${on}, ${purpose === "deposit" ? "1020" : method.settles_to_gl},
                ${c.get("user").id}, ${c.get("user").name}, ${note ?? null})
        RETURNING *`;

      await tx`INSERT INTO payment_events (id, payment_id, event, detail, actor_name)
        VALUES (${uid("pe_")}, ${p.id}, 'entered',
                ${`${money(paid)} by ${method.label_en}${cheque_number ? `, cheque ${cheque_number}` : ""}, received ${on}`},
                ${c.get("user").name})`;

      const applied = purpose === "deposit"
        ? []
        : await applyToCharges(tx, p, unit_number, apply_to);

      return { payment: p, method, applied, leaseId: lease?.id ?? null };
    });

    const account = purpose === "deposit"
      ? null : await leaseBalance(sql, out.leaseId);

    await audit(c, { action: "payment.manual", entityType: "payment",
      entityId: out.payment.id,
      after: { unit: unit_number, amount, method: method_code, purpose } });

    return c.json({ payment: out.payment, applied: out.applied, account,
      note: out.method.reversible_days > 0
        ? `Recorded as received. A ${out.method.label_en.toLowerCase()} can still be reversed for up to ${out.method.reversible_days} days, so it is not settled until it clears.`
        : null }, 201);
  } catch (e) {
    if (e.code === "23505" && e.constraint_name === "idx_pay_cheque")
      return c.json({ code: "DUPLICATE_CHEQUE",
        detail: "This cheque number has already been recorded for the unit." }, 409);
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

/**
 * Which charges the money settles.
 *
 * Rent first and oldest first, unless the tenant directed otherwise. That
 * direction is recorded as coming from them — the difference between "they
 * asked us to" and "we decided" matters if it is ever questioned.
 */
async function applyToCharges(tx, payment, unit, directed) {
  const open = await tx`
    SELECT id, kind, amount, paid_amount, due_date FROM ar_charges
    WHERE unit_number = ${unit} AND state IN ('open','partial')
    ORDER BY due_date`;

  const ordered = directed?.length
    ? directed.map((id) => open.find((x) => x.id === id)).filter(Boolean)
    : orderCharges(open);

  let left = Number(payment.amount);
  const applied = [];

  for (const ch of ordered) {
    if (left <= 0.005) break;
    const owing = cents(Number(ch.amount) - Number(ch.paid_amount));
    if (owing <= 0) continue;

    const take = Math.min(left, owing);
    await tx`INSERT INTO payment_applications (id, payment_id, charge_id, amount,
      directed_by) VALUES (${uid("pa_")}, ${payment.id}, ${ch.id}, ${cents(take)},
                           ${directed?.length ? "tenant" : "rule"})`;
    await tx`UPDATE ar_charges
      SET paid_amount = paid_amount + ${cents(take)},
          state = CASE WHEN paid_amount + ${cents(take)} >= amount - 0.005
                       THEN 'paid' ELSE 'partial' END
      WHERE id = ${ch.id}`;

    applied.push({ charge_id: ch.id, kind: ch.kind, due_date: ch.due_date,
                   amount: cents(take) });
    left = cents(left - take);
  }

  /* Money left over is prepaid rent, not a windfall. It sits as a liability
     until there is a charge for it to settle, and treating it as income now
     means recognising rent for a month that has not happened. */
  if (left > 0.005)
    await tx`INSERT INTO payment_events (id, payment_id, event, detail)
      VALUES (${uid("pe_")}, ${payment.id}, 'unapplied',
              ${`${money(left)} more than was owed. Held as prepaid rent until there is a charge for it.`})`;

  return { applied, unapplied: cents(left) };
}

/** A cheque that bounced, or a debit reversed.
 *
 *  Not a deletion. The payment happened, the reversal happened, and both are
 *  part of the history — a receipt that vanishes leaves a tenant holding one
 *  the system does not recognise. */
r.post("/payments/:id/reverse", ledgerEditor, async (c) => {
  const sql = c.get("db");
  const { reason, fee } = await c.req.json();
  if (!reason?.trim()) return c.json({ code: "REASON_REQUIRED" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [p] = await tx`SELECT * FROM payments WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!p) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (p.state === "reversed")
        throw Object.assign(new Error("ALREADY_REVERSED"), { status: 409 });

      // Put the charges back. They were never actually paid.
      const apps = await tx`SELECT * FROM payment_applications
        WHERE payment_id = ${p.id}`;
      for (const a of apps)
        await tx`UPDATE ar_charges
          SET paid_amount = paid_amount - ${a.amount},
              state = CASE WHEN paid_amount - ${a.amount} <= 0.005 THEN 'open'
                           ELSE 'partial' END
          WHERE id = ${a.charge_id}`;

      await tx`UPDATE payments SET state = 'reversed', failure_note = ${reason.trim()}
        WHERE id = ${p.id}`;
      await tx`INSERT INTO payment_events (id, payment_id, event, detail, actor_name)
        VALUES (${uid("pe_")}, ${p.id}, 'reversed', ${reason.trim()},
                ${c.get("user").name})`;

      return { unit: p.unit_number, amount: p.amount,
               charges_reopened: apps.length };
    });

    await audit(c, { action: "payment.reverse", entityType: "payment",
      entityId: c.req.param("id"), after: { ...out, reason } });

    return c.json({ ok: true, ...out,
      note: "The charges are open again. A returned-item fee is a separate charge with its own basis, not an adjustment to this one." });
  } catch (e) {
    return c.json({ code: e.message }, e.status ?? 500);
  }
});

/* ---------- Reading ---------- */

r.get("/payments", require_("accounting.view"), async (c) => {
  const sql = c.get("db");
  const { state, unit, limit = 200 } = c.req.query();

  const rows = unit
    ? await sql`SELECT p.*, m.label_en AS method_label FROM payments p
        JOIN payment_methods m ON m.code = p.method_code
        WHERE p.unit_number = ${unit} ORDER BY p.created_at DESC LIMIT ${Number(limit)}`
    : state
    ? await sql`SELECT p.*, m.label_en AS method_label FROM payments p
        JOIN payment_methods m ON m.code = p.method_code
        WHERE p.state = ${state} ORDER BY p.created_at DESC LIMIT ${Number(limit)}`
    : await sql`SELECT p.*, m.label_en AS method_label FROM payments p
        JOIN payment_methods m ON m.code = p.method_code
        ORDER BY p.created_at DESC LIMIT ${Number(limit)}`;

  // What the fees are costing. Rarely looked at, and the reason a card
  // programme runs for two years before anybody adds it up.
  const [fees] = await sql`
    SELECT COALESCE(SUM(fee_amount), 0) AS total,
           COUNT(*) FILTER (WHERE fee_amount > 0) AS with_fee
    FROM payments WHERE state IN ('settled','authorised')
      AND created_at > now() - INTERVAL '365 days'`;

  return c.json({ payments: rows,
    fees_last_year: { total: Number(fees.total), payments: Number(fees.with_fee) } });
});

/* ---------- Staff unit ledger ----------
 *
 * Every staff role that may open Units can read the same tenant statement.
 * Posting remains behind accounting.ar, which only Admin and Accounting have.
 * Corrections are additional adjustments or reversals; posted history is never
 * overwritten or deleted. */
r.get("/units/:unit/ledger", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const unit = c.req.param("unit");
  const [known] = await sql`SELECT unit_number FROM units WHERE unit_number = ${unit}`;
  if (!known) return c.json({ code: "NOT_FOUND" }, 404);

  const [lease] = await sql`SELECT id FROM leases
    WHERE unit_number = ${unit} AND status = 'active'
    ORDER BY start_date DESC, created_at DESC LIMIT 1`;

  const charges = lease ? await sql`
    SELECT id, period, kind, description, amount, paid_amount, charge_date,
           due_date, state, created_at
    FROM ar_charges
    WHERE lease_id = ${lease.id} AND state <> 'void'
    ORDER BY charge_date, created_at` : [];
  const payments = lease ? await sql`
    SELECT p.id, p.reference, p.purpose, p.amount, p.state, p.received_on,
           p.settled_on, p.failure_note, p.note, p.created_at,
           m.label_en AS method_label
    FROM payments p
    JOIN payment_methods m ON m.code = p.method_code
    WHERE p.lease_id = ${lease.id}
    ORDER BY COALESCE(p.received_on, p.created_at::date), p.created_at` : [];
  const deposits = lease ? await sql`
    SELECT id, kind, amount, txn_date, basis, created_at
    FROM deposit_ledger WHERE lease_id = ${lease.id}
    ORDER BY txn_date, created_at` : [];

  const effectivePayment = (p) => p.purpose !== "deposit" &&
    ["authorised", "settled"].includes(p.state) ? Number(p.amount) : 0;
  const transactions = [
    ...charges.map((x) => {
      const amount = Number(x.amount);
      return {
        id: x.id, source: "charge", date: x.charge_date, created_at: x.created_at,
        kind: x.kind, description: x.description || x.kind,
        debit: amount > 0 ? amount : 0, credit: amount < 0 ? Math.abs(amount) : 0,
        state: x.state,
      };
    }),
    ...payments.filter((x) => x.purpose !== "deposit").map((x) => ({
      id: x.id, source: "payment", date: x.received_on || x.created_at,
      created_at: x.created_at, kind: x.purpose,
      description: `${x.method_label} · ${x.reference}${x.failure_note ? ` · ${x.failure_note}` : ""}`,
      debit: 0, credit: effectivePayment(x), amount: Number(x.amount), state: x.state,
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
    String(a.created_at).localeCompare(String(b.created_at)));

  let running = 0;
  for (const row of transactions) {
    running = cents(running + Number(row.debit) - Number(row.credit));
    row.balance = running;
  }

  const totalDebits = transactions.reduce((n, x) => n + Number(x.debit), 0);
  const totalCredits = transactions.reduce((n, x) => n + Number(x.credit), 0);
  const balance = cents(totalDebits - totalCredits);
  const overdue = charges.filter((x) => ["open", "partial"].includes(x.state) &&
    new Date(x.due_date) < new Date()).reduce((n, x) =>
      n + Number(x.amount) - Number(x.paid_amount), 0);

  return c.json({
    unit, lease_id: lease?.id ?? null, transactions: transactions.reverse(), deposits,
    deposit_payments: payments.filter((x) => x.purpose === "deposit"),
    summary: {
      balance,
      outstanding: Math.max(0, balance),
      prepayment: Math.max(0, cents(-balance)),
      total_debits: cents(totalDebits), total_credits: cents(totalCredits),
      overdue: cents(overdue),
      deposit_held: cents(deposits.reduce((n, x) => n + Number(x.amount), 0)),
    },
    can_edit: ["admin", "accounting"].includes(c.get("user")?.role),
  });
});

r.post("/units/:unit/ledger/charges", ledgerEditor, async (c) => {
  const sql = c.get("db");
  const unit = c.req.param("unit");
  const body = await c.req.json().catch(() => ({}));
  const amount = cents(body.amount);
  const direction = body.direction === "credit" ? "credit" : "debit";
  const kind = CHARGE_ACCOUNTS[body.kind] ? body.kind : "other";
  const chargeDate = body.date || today();
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(chargeDate))
    return c.json({ code: "INVALID_LEDGER_ENTRY" }, 400);
  if (!String(body.description ?? "").trim())
    return c.json({ code: "DESCRIPTION_REQUIRED" }, 400);

  const [context] = await sql`
    SELECT u.building_code, l.id AS lease_id, l.contact_id
    FROM units u
    LEFT JOIN leases l ON l.unit_number = u.unit_number AND l.status = 'active'
    WHERE u.unit_number = ${unit}
    ORDER BY l.created_at DESC NULLS LAST LIMIT 1`;
  if (!context) return c.json({ code: "NOT_FOUND" }, 404);

  const signed = direction === "credit" ? -amount : amount;
  const [charge] = await sql`
    INSERT INTO ar_charges (id, lease_id, unit_number, contact_id, building_code,
      period, kind, gl_code, description, amount, charge_date, due_date, state)
    VALUES (${uid("ch_")}, ${context.lease_id ?? null}, ${unit},
      ${context.contact_id ?? null}, ${context.building_code}, ${chargeDate.slice(0, 7)},
      ${kind}, ${CHARGE_ACCOUNTS[kind]}, ${String(body.description).trim()}, ${signed},
      ${chargeDate}, ${body.due_date || chargeDate}, 'open')
    RETURNING *`;
  await audit(c, { action: direction === "credit" ? "ledger.credit" : "ledger.charge",
    entityType: "ar_charge", entityId: charge.id,
    after: { unit, amount: signed, kind, description: charge.description } });
  return c.json({ charge }, 201);
});

r.post("/units/:unit/ledger/charges/:id/void", ledgerEditor, async (c) => {
  const sql = c.get("db");
  const unit = c.req.param("unit");
  const { reason } = await c.req.json().catch(() => ({}));
  if (!String(reason ?? "").trim()) return c.json({ code: "REASON_REQUIRED" }, 400);
  const [applied] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS total FROM payment_applications
    WHERE charge_id = ${c.req.param("id")}`;
  if (Number(applied?.total) > 0)
    return c.json({ code: "CHARGE_HAS_PAYMENTS", detail: "Reverse the applied payment before voiding this charge." }, 409);
  const [before] = await sql`SELECT * FROM ar_charges
    WHERE id = ${c.req.param("id")} AND unit_number = ${unit}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  if (before.state === "void") return c.json({ code: "ALREADY_VOID" }, 409);
  const [charge] = await sql`UPDATE ar_charges SET state = 'void',
    description = ${`${before.description || before.kind} · Voided: ${String(reason).trim()}`}
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "ledger.charge.void", entityType: "ar_charge",
    entityId: before.id, before, after: { ...charge, void_reason: String(reason).trim() } });
  return c.json({ charge });
});

r.get("/tenant/payments", async (c) => {
  const unit = tenantUnit(c);
  return c.json({ payments: await c.get("db")`
    SELECT p.reference, p.amount, p.fee_amount, p.total_charged, p.purpose,
           p.state, p.received_on, p.settled_on, m.label_en, m.label_zh
    FROM payments p JOIN payment_methods m ON m.code = p.method_code
    WHERE p.unit_number = ${unit} ORDER BY p.created_at DESC LIMIT 50` });
});

export default r;
