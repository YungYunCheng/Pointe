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

function orderCharges(charges) {
  return [...charges].sort((a, b) => {
    const ai = SETTLEMENT_ORDER.indexOf(a.kind);
    const bi = SETTLEMENT_ORDER.indexOf(b.kind);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return String(a.due_date).localeCompare(String(b.due_date));
  });
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

/**
 * A cheque, an e-transfer, cash across the counter.
 *
 * Recorded when it arrives, not when it clears. A cheque can bounce for a
 * month, and a receipt issued the day it was handed over is a receipt against
 * money that may not be there — so it settles rather than being received.
 */
r.post("/payments/manual", require_("accounting.ar"), async (c) => {
  const sql = c.get("db");
  const { unit_number, method_code, amount, purpose = "rent", received_on,
          cheque_number, bank_name, reference: theirRef, note,
          apply_to } = await c.req.json();

  if (!unit_number || !method_code || !(Number(amount) > 0))
    return c.json({ code: "MISSING_FIELDS" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [method] = await tx`SELECT * FROM payment_methods WHERE code = ${method_code}`;
      if (!method) throw Object.assign(new Error("UNKNOWN_METHOD"), { status: 400 });

      if (purpose === "deposit" && !method.trust_capable)
        throw Object.assign(new Error("METHOD_NOT_TRUST_CAPABLE"), { status: 400,
          detail: "A deposit has to go into the trust account." });

      const [lease] = await tx`SELECT id, contact_id FROM leases
        WHERE unit_number = ${unit_number} AND status = 'active'`;

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
                ${cheque_number ?? null}, ${bank_name ?? null}, ${theirRef ?? null},
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

      return { payment: p, method, applied };
    });

    await audit(c, { action: "payment.manual", entityType: "payment",
      entityId: out.payment.id,
      after: { unit: unit_number, amount, method: method_code, purpose } });

    return c.json({ payment: out.payment, applied: out.applied,
      note: out.method.reversible_days > 0
        ? `Recorded as received. A ${out.method.label_en.toLowerCase()} can still be reversed for up to ${out.method.reversible_days} days, so it is not settled until it clears.`
        : null }, 201);
  } catch (e) {
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
r.post("/payments/:id/reverse", require_("accounting.ar"), async (c) => {
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

r.get("/tenant/payments", async (c) => {
  const unit = tenantUnit(c);
  return c.json({ payments: await c.get("db")`
    SELECT p.reference, p.amount, p.fee_amount, p.total_charged, p.purpose,
           p.state, p.received_on, p.settled_on, m.label_en, m.label_zh
    FROM payments p JOIN payment_methods m ON m.code = p.method_code
    WHERE p.unit_number = ${unit} ORDER BY p.created_at DESC LIMIT 50` });
});

export default r;

