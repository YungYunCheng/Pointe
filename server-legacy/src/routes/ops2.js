import { Router } from "express";
import crypto from "node:crypto";
import { db, uid, nowISO, cents, txn } from "../db.js";
import { authenticate, require_, audit, notify, effectivePermissions, PERMISSIONS }
  from "../rbac.js";
import { queue, requestConfirmation } from "../outbox.js";

const r = Router();

/* ============================================================
   Purchase orders, tenant receipts, escalation and the key gate
   ============================================================ */

const today = () => new Date().toISOString().slice(0, 10);
const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const money = (n) => (n == null ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));

/* ---------- Public: replying to an escalation ----------
   No session. The token identifies one thread and is useless for anything
   else. A tenant should not have to create an account to answer a question
   they were asked. */

r.get("/public/escalation/:token", (req, res) => {
  const e = db.prepare("SELECT * FROM escalations WHERE reply_token=?").get(req.params.token);
  if (!e) return res.status(404).json({ code: "THREAD_NOT_FOUND" });
  res.json({ state: e.state, answered_at: e.answered_at,
             answer: e.state === "answered" ? e.answer_body : null });
});

r.use(authenticate);

/* ================= Escalation ================= */
/*
   Handing a message to a person is not the same as a person seeing it.
   An escalation becomes an email to the role that owns it, with the
   thread and a clock, so a tenant is not waiting on somebody happening
   to open a console.
*/

const ESCALATION_HOURS = 4;          // working hours to first response
const SENSITIVE_RULES = ["R-101", "R-102", "R-103"];

/** Raised by the inbox or the tenant chat when a hard stop fires, or when a
 *  draft is downgraded. Emails whoever owns it rather than leaving a badge on
 *  a screen nobody is looking at. */
r.post("/escalations", require_("notifications.view"), (req, res) => {
  const { message_id, source, rule_id, topic, tenant_name, tenant_email, tenant_phone,
          unit_number, locale, body, assigned_role } = req.body ?? {};
  if (!tenant_name && !tenant_email) return res.status(400).json({ code: "NO_TENANT" });

  // For the protected-ground rules the content is not copied into the
  // escalation or the notification email. The person opens the thread to read
  // it; what travels is the rule id.
  const sensitive = SENSITIVE_RULES.includes(rule_id);
  const role = assigned_role ?? "property_manager";
  const id = uid("esc_");
  const token = crypto.randomBytes(18).toString("base64url");
  const due = new Date(Date.now() + ESCALATION_HOURS * 3600e3).toISOString();

  const recipients = db.prepare(`SELECT id, email, full_name FROM users
    WHERE is_active = 1 AND role_code IN (?, 'admin')`).all(role);

  const link = `${process.env.PUBLIC_URL || "http://localhost:8080"}/inbox?thread=${id}`;
  const summary = sensitive
    ? `A message from ${tenant_name ?? "a tenant"}${unit_number ? ` (${unit_number})` : ""} needs a person. Rule ${rule_id}. The content is not repeated here — open the thread to read it.`
    : `A message from ${tenant_name ?? "a tenant"}${unit_number ? ` (${unit_number})` : ""} needs a person.\n\n${body ?? ""}`;

  let firstOutbox = null;
  for (const u of recipients) {
    const msg = queue({
      kind: "escalation", channel: "email", toEmail: u.email, toName: u.full_name,
      subject: `Needs a reply${unit_number ? ` · ${unit_number}` : ""}${rule_id ? ` · ${rule_id}` : ""}`,
      body: [summary, "", `Open it here: ${link}`, "",
             `Expected first response by ${due.slice(0, 16).replace("T", " ")}.`].join("\n"),
      refType: "escalation", refId: id, requiredBy: due, userId: req.user.id,
    });
    firstOutbox = firstOutbox ?? msg.id;
  }

  db.prepare(`INSERT INTO escalations (id, message_id, source, rule_id, topic, tenant_name,
    tenant_email, tenant_phone, unit_number, locale, body_included, body, assigned_role,
    outbox_id, reply_token, due_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, message_id ?? null, source ?? "inbox", rule_id ?? null, topic ?? null,
         tenant_name ?? null, tenant_email ?? null, tenant_phone ?? null,
         unit_number ?? null, locale ?? "en", sensitive ? 0 : 1,
         sensitive ? null : (body ?? null), role, firstOutbox, token, due);

  // The tenant is told a person has it, with a realistic expectation rather
  // than silence. Silence is what turns a question into a complaint.
  if (tenant_email) {
    const zh = locale === "zh";
    queue({ kind: "escalation_ack", channel: "email", toEmail: tenant_email,
      toName: tenant_name, locale: locale ?? "en",
      subject: zh ? "已收到你的訊息" : "We have your message",
      body: zh
        ? ["你好，", "", "你的訊息已經轉給我們的同事處理，通常一個工作天內會回覆你。",
           "如果情況緊急，請直接打電話到辦公室。"].join("\n")
        : ["Hello,", "",
           "Your message has been passed to a colleague and you will normally hear back within one business day.",
           "If it is urgent, please call the office rather than waiting here."].join("\n"),
      refType: "escalation", refId: id });
  }

  audit(req, { action: "escalation.raise", entityType: "escalation", entityId: id,
               after: { rule_id, role, notified: recipients.length,
                        content_copied: !sensitive } });
  res.status(201).json({ id, assigned_role: role, due_by: due,
                         notified: recipients.length });
});

r.get("/escalations", require_("notifications.view"), (req, res) => {
  const { state = "open", limit = 100 } = req.query;
  const rows = db.prepare(`SELECT * FROM escalations
    ${state === "all" ? "" : "WHERE state = ?"}
    ORDER BY due_by LIMIT ?`).all(...(state === "all" ? [Number(limit)] : [state, Number(limit)]));
  const overdue = rows.filter((e) => e.state === "open" && e.due_by < nowISO()).length;
  res.json({ escalations: rows, overdue });
});

r.post("/escalations/:id/claim", require_("escalation.answer"), (req, res) => {
  const e = db.prepare("SELECT * FROM escalations WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ code: "NOT_FOUND" });
  if (e.state !== "open")
    return res.status(409).json({ code: "ALREADY_CLAIMED", by: e.claimed_name });
  db.prepare(`UPDATE escalations SET state='claimed', claimed_by=?, claimed_name=?,
    claimed_at=? WHERE id=?`).run(req.user.id, req.user.name, nowISO(), e.id);
  audit(req, { action: "escalation.claim", entityType: "escalation", entityId: e.id });
  res.json({ ok: true });
});

r.post("/escalations/:id/answer", require_("escalation.answer"), (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ code: "BODY_REQUIRED" });
  const e = db.prepare("SELECT * FROM escalations WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ code: "NOT_FOUND" });

  const msg = e.tenant_email
    ? queue({ kind: "escalation_reply", channel: "email", toEmail: e.tenant_email,
        toName: e.tenant_name, locale: e.locale,
        subject: e.locale === "zh" ? "回覆你的詢問" : "Re: your enquiry",
        body, refType: "escalation", refId: e.id, userId: req.user.id })
    : null;

  db.prepare(`UPDATE escalations SET state='answered', answered_at=?, answer_body=? WHERE id=?`)
    .run(nowISO(), body, e.id);
  audit(req, { action: "escalation.answer", entityType: "escalation", entityId: e.id,
               after: { by: req.user.name, sent: !!msg } });
  res.json({ ok: true, message: msg });
});

/* ================= Purchase orders ================= */
/*
   A purchase order is a commitment, not a liability, so it does not
   touch the ledger. It becomes a bill when the work is done and the
   amount is confirmed — and the amount usually changes, which is the
   reason for two steps rather than one.
*/

function nextPoNumber() {
  const n = db.prepare(`SELECT COUNT(*) n FROM purchase_orders
    WHERE po_number LIKE ?`).get(`PO-${new Date().getFullYear()}-%`).n;
  return `PO-${new Date().getFullYear()}-${String(n + 1).padStart(4, "0")}`;
}

r.get("/purchase-orders", require_("accounting.view"), (req, res) => {
  const { state, ticket_id, limit = 200 } = req.query;
  let sql = `SELECT po.*, m.description ticket_description, m.priority
             FROM purchase_orders po LEFT JOIN maintenance m ON m.id = po.ticket_id WHERE 1=1`;
  const args = [];
  if (state) { sql += " AND po.state = ?"; args.push(state); }
  if (ticket_id) { sql += " AND po.ticket_id = ?"; args.push(ticket_id); }
  sql += " ORDER BY po.created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  const rows = db.prepare(sql).all(...args);
  const lines = db.prepare("SELECT * FROM purchase_order_lines ORDER BY line_no").all();
  res.json({ purchase_orders: rows.map((p) => ({ ...p,
    lines: lines.filter((l) => l.po_id === p.id) })) });
});

r.post("/purchase-orders", require_("po.create"), (req, res) => {
  const { ticket_id, vendor_id, vendor_name, unit_number, description, scope,
          gl_code, scheduled_at, lines = [], drafted_by_ai, ai_model } = req.body ?? {};
  if (!description?.trim()) return res.status(400).json({ code: "DESCRIPTION_REQUIRED" });
  if (!lines.length) return res.status(400).json({ code: "LINES_REQUIRED" });

  const estimated = cents(lines.reduce((t, l) => t + Number(l.estimated || 0), 0));
  const unit = unit_number
    ? db.prepare("SELECT building_code FROM units WHERE unit_number=?").get(unit_number) : null;
  const po = nextPoNumber();
  const id = uid("po_");

  db.transaction(() => {
    db.prepare(`INSERT INTO purchase_orders (id, po_number, ticket_id, vendor_id, vendor_name,
      unit_number, building_code, description, scope, gl_code, estimated, scheduled_at,
      drafted_by_ai, ai_model, created_by, created_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, po, ticket_id ?? null, vendor_id ?? null, vendor_name ?? null,
           unit_number ?? null, unit?.building_code ?? null, description.trim(),
           scope ?? null, gl_code ?? "5010", estimated, scheduled_at ?? null,
           drafted_by_ai ? 1 : 0, ai_model ?? null, req.user.id, req.user.name);
    const ins = db.prepare(`INSERT INTO purchase_order_lines (id, po_id, line_no, description,
      gl_code, quantity, unit_price, estimated) VALUES (?,?,?,?,?,?,?,?)`);
    lines.forEach((l, i) => ins.run(uid("pol_"), id, i + 1, l.description ?? "",
      l.gl_code ?? gl_code ?? "5010", l.quantity ?? 1, l.unit_price ?? null,
      cents(l.estimated)));
  })();

  audit(req, { action: "po.create", entityType: "purchase_order", entityId: id,
               after: { po_number: po, estimated, vendor: vendor_name,
                        drafted_by_ai: !!drafted_by_ai } });
  res.status(201).json({ id, po_number: po, estimated });
});

r.post("/purchase-orders/:id/issue", require_("po.create"), (req, res) => {
  const p = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "PO_NOT_FOUND" });
  if (p.state !== "draft") return res.status(409).json({ code: "NOT_DRAFT", state: p.state });

  db.prepare("UPDATE purchase_orders SET state='issued' WHERE id=?").run(p.id);
  notify("accounting", "po", "PO_ISSUED",
         { po_number: p.po_number, estimated: p.estimated, vendor: p.vendor_name },
         `/accounting/ap?po=${p.id}`);
  audit(req, { action: "po.issue", entityType: "purchase_order", entityId: p.id,
               after: { po_number: p.po_number, estimated: p.estimated } });
  res.json({ ok: true });
});

/** The work is done and the amount is known. Whoever was on site enters the
 *  actual, and a difference from the estimate needs a reason — an unexplained
 *  variance is the one thing an owner will ask about. */
r.post("/purchase-orders/:id/confirm", require_("po.confirm"), (req, res) => {
  const { actual_amount, variance_note, lines } = req.body ?? {};
  const p = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "PO_NOT_FOUND" });
  if (!["issued", "draft"].includes(p.state))
    return res.status(409).json({ code: "NOT_CONFIRMABLE", state: p.state });
  if (actual_amount == null) return res.status(400).json({ code: "ACTUAL_REQUIRED" });

  const actual = cents(actual_amount);
  const variance = cents(actual - p.estimated);
  if (Math.abs(variance) >= 0.01 && !variance_note?.trim())
    return res.status(400).json({ code: "VARIANCE_NOTE_REQUIRED",
      estimated: p.estimated, actual, variance });

  db.transaction(() => {
    db.prepare(`UPDATE purchase_orders SET state='work_done', actual_amount=?,
      variance_note=?, confirmed_by=?, confirmed_name=?, confirmed_at=? WHERE id=?`)
      .run(actual, variance_note ?? null, req.user.id, req.user.name, nowISO(), p.id);
    if (lines?.length) {
      const up = db.prepare("UPDATE purchase_order_lines SET actual=? WHERE id=?");
      for (const l of lines) if (l.id && l.actual != null) up.run(cents(l.actual), l.id);
    }
  })();

  notify("accounting", "po", "PO_READY_TO_BILL",
         { po_number: p.po_number, actual, variance }, `/accounting/ap?po=${p.id}`);
  audit(req, { action: "po.confirm", entityType: "purchase_order", entityId: p.id,
               before: { estimated: p.estimated },
               after: { actual, variance, note: variance_note ?? null, by: req.user.name } });
  res.json({ ok: true, actual, variance });
});

/** Copies the confirmed order into a draft bill. The bill is what posts, and
 *  it still goes through the usual approval — the order proves what was
 *  agreed, the bill is what we owe. */
r.post("/purchase-orders/:id/to-bill", require_("po.bill"), (req, res) => {
  try {
    const out = txn(() => {
      const p = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(req.params.id);
      if (!p) throw Object.assign(new Error("PO_NOT_FOUND"), { status: 404 });
      if (p.state !== "work_done")
        throw Object.assign(new Error("NOT_CONFIRMED"), { status: 409, state: p.state });
      if (p.bill_id) throw Object.assign(new Error("ALREADY_BILLED"), { status: 409 });
      if (!p.vendor_id) throw Object.assign(new Error("NO_VENDOR"), { status: 400 });

      const invoiceNo = req.body?.invoice_no?.trim() || p.po_number;
      if (db.prepare("SELECT 1 FROM ap_invoices WHERE vendor_id=? AND invoice_no=?")
            .get(p.vendor_id, invoiceNo))
        throw Object.assign(new Error("DUPLICATE_INVOICE"), { status: 409, invoiceNo });

      const poLines = db.prepare("SELECT * FROM purchase_order_lines WHERE po_id=? ORDER BY line_no")
                        .all(p.id);
      const gst = cents(req.body?.gst ?? 0);
      const subtotal = cents(poLines.reduce((t, l) => t + Number(l.actual ?? l.estimated), 0));
      const total = cents(subtotal + gst);
      const vendor = db.prepare("SELECT * FROM vendors WHERE id=?").get(p.vendor_id);
      const invoiceDate = req.body?.invoice_date || today();
      const due = req.body?.due_date
        || new Date(Date.now() + (vendor?.payment_terms ?? 30) * 864e5).toISOString().slice(0, 10);

      const billId = uid("ap_");
      db.prepare(`INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date, due_date,
        building_code, unit_number, subtotal, gst, total, description, ticket_id, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(billId, p.vendor_id, invoiceNo, invoiceDate, due, p.building_code,
             p.unit_number, subtotal, gst, total,
             `${p.description} (${p.po_number})`, p.ticket_id, req.user.id);

      const insL = db.prepare(`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
        description, amount, building_code, unit_number) VALUES (?,?,?,?,?,?,?,?)`);
      poLines.forEach((l, i) => insL.run(uid("al_"), billId, i + 1,
        l.gl_code ?? p.gl_code ?? "5010", l.description,
        cents(l.actual ?? l.estimated), p.building_code, p.unit_number));

      db.prepare("UPDATE purchase_orders SET state='billed', bill_id=? WHERE id=?")
        .run(billId, p.id);
      return { bill_id: billId, invoice_no: invoiceNo, subtotal, gst, total,
               po_number: p.po_number };
    })();
    audit(req, { action: "po.to_bill", entityType: "purchase_order", entityId: req.params.id,
                 after: out });
    res.status(201).json({ ...out,
      note: "Created as a draft bill. It posts to the ledger when Accounting approves it." });
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, state: e.state,
                                        invoice_no: e.invoiceNo });
  }
});

r.post("/purchase-orders/:id/cancel", require_("po.create"), (req, res) => {
  const reason = req.body?.reason;
  if (!reason?.trim()) return res.status(400).json({ code: "REASON_REQUIRED" });
  const p = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "PO_NOT_FOUND" });
  if (p.state === "billed") return res.status(409).json({ code: "ALREADY_BILLED" });
  db.prepare("UPDATE purchase_orders SET state='cancelled', cancelled_reason=? WHERE id=?")
    .run(reason.trim(), p.id);
  audit(req, { action: "po.cancel", entityType: "purchase_order", entityId: p.id,
               before: { state: p.state }, after: { reason: reason.trim() } });
  res.json({ ok: true });
});

/* ================= Tenant receipts ================= */
/*
   Issued after Accounting confirms the money, never on the promise of it.
   A receipt for a payment that later bounces is worse than no receipt.
*/

r.post("/receipts/:arReceiptId/issue", require_("accounting.ar"), (req, res) => {
  const rc = db.prepare("SELECT * FROM ar_receipts WHERE id=?").get(req.params.arReceiptId);
  if (!rc) return res.status(404).json({ code: "RECEIPT_NOT_FOUND" });
  if (db.prepare("SELECT 1 FROM payment_receipts WHERE ar_receipt_id=?").get(rc.id))
    return res.status(409).json({ code: "ALREADY_ISSUED" });

  const applied = db.prepare(`SELECT ara.amount, c.period, c.kind FROM ar_applications ara
    JOIN ar_charges c ON c.id = ara.charge_id WHERE ara.receipt_id = ?`).all(rc.id);
  const balance = db.prepare(`SELECT SUM(amount - paid_amount) t FROM ar_charges
    WHERE unit_number=? AND state IN ('open','partial')`).get(rc.unit_number)?.t ?? 0;

  const contact = rc.contact_id
    ? db.prepare("SELECT * FROM contacts WHERE id=?").get(rc.contact_id) : null;
  const email = req.body?.email ?? contact?.email;
  const locale = contact?.locale ?? "en";

  const n = db.prepare("SELECT COUNT(*) n FROM payment_receipts").get().n + 1;
  const number = `R-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`;
  const id = uid("prc_");

  const zh = locale === "zh";
  const lines = zh ? [
    `${contact?.full_name ?? "住戶"} 你好，`, "",
    `已收到你的款項，收據編號 ${number}。`, "",
    `金額：${money(rc.amount)}`,
    `收款日：${rc.received_date}`,
    `方式：${rc.method}`,
    rc.unit_number ? `單位：${rc.unit_number}` : "",
    "", applied.length ? "沖抵項目：" : "",
    ...applied.map((a) => `  ${a.period} ${a.kind}  ${money(a.amount)}`),
    "", cents(balance) > 0 ? `目前尚欠：${money(cents(balance))}` : "目前無欠款。",
    "", "如有疑問請回覆這封信。",
  ] : [
    `Hello ${contact?.full_name ?? "there"},`, "",
    `We have received your payment. Receipt ${number}.`, "",
    `Amount: ${money(rc.amount)}`,
    `Received: ${rc.received_date}`,
    `Method: ${rc.method}`,
    rc.unit_number ? `Suite: ${rc.unit_number}` : "",
    "", applied.length ? "Applied to:" : "",
    ...applied.map((a) => `  ${a.period} ${a.kind}  ${money(a.amount)}`),
    "", cents(balance) > 0 ? `Balance outstanding: ${money(cents(balance))}`
                           : "Nothing is outstanding.",
    "", "Reply to this message with any question.",
  ];

  let msg = null;
  if (email) {
    msg = queue({ kind: "rent_receipt", channel: "email", toEmail: email,
      toName: contact?.full_name, locale,
      subject: zh ? `收據 ${number} · ${money(rc.amount)}` : `Receipt ${number} · ${money(rc.amount)}`,
      body: lines.filter((x) => x !== "").join("\n"),
      refType: "payment_receipt", refId: id, userId: req.user.id });
  }

  db.prepare(`INSERT INTO payment_receipts (id, receipt_number, ar_receipt_id, unit_number,
    tenant_name, tenant_email, amount, received_date, method, applied_to, balance_after,
    locale, outbox_id, state, confirmed_by, confirmed_name, sent_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, number, rc.id, rc.unit_number, contact?.full_name ?? null, email ?? null,
         rc.amount, rc.received_date, rc.method, JSON.stringify(applied), cents(balance),
         locale, msg?.id ?? null, msg ? "sent" : "pending", req.user.id, req.user.name,
         msg ? nowISO() : null);

  audit(req, { action: "receipt.issue", entityType: "payment_receipt", entityId: id,
               after: { number, amount: rc.amount, to: email ?? "(no email)" } });
  res.status(201).json({ id, receipt_number: number, sent: !!msg });
});

r.get("/receipts", require_("accounting.view"), (req, res) => {
  res.json({ receipts: db.prepare(`SELECT * FROM payment_receipts
    ORDER BY created_at DESC LIMIT 300`).all()
    .map((x) => ({ ...x, applied_to: parse(x.applied_to, []) })) });
});

/** Receipts owed: money confirmed but nothing sent to the tenant yet. Without
 *  this, a receipt is remembered only when somebody asks for one. */
r.get("/receipts/pending", require_("accounting.view"), (req, res) => {
  const rows = db.prepare(`SELECT rc.* FROM ar_receipts rc
    LEFT JOIN payment_receipts pr ON pr.ar_receipt_id = rc.id
    WHERE pr.id IS NULL ORDER BY rc.received_date DESC LIMIT 200`).all();
  res.json({ pending: rows, count: rows.length });
});

/* ================= Key release gate ================= */
/*
   Keys cannot be booked until the Property Manager confirms the lease is
   signed. Handing over possession against an unsigned lease leaves nothing
   to enforce, and it is not a mistake that can be undone quietly.
*/

r.get("/key-release/:unit", require_("units.view"), (req, res) => {
  const a = db.prepare(`SELECT * FROM key_release_approvals WHERE unit_number=?
    ORDER BY created_at DESC LIMIT 1`).get(req.params.unit);
  const signed = db.prepare(`SELECT * FROM agreement_issues ai
    JOIN agreements ag ON ag.id = ai.agreement_id
    WHERE ai.unit_number=? AND ag.code='lease' AND ai.state='signed'
    ORDER BY ai.signed_at DESC LIMIT 1`).get(req.params.unit);
  res.json({
    approval: a ?? null,
    lease_signed: !!signed,
    signed_at: signed?.signed_at ?? null,
    // What the Building Manager needs to see: can keys be booked, and if not,
    // what is missing.
    can_schedule_keys: !!a?.approved_at,
    blocked_reason: a?.approved_at ? null
      : signed ? "The lease is signed but the Property Manager has not released keys yet."
               : "No signed lease on file for this unit.",
  });
});

/** The Property Manager's sign-off. Deposit and first rent are recorded
 *  because those are the two things that are awkward to collect afterwards. */
r.post("/key-release", require_("keys.release"), (req, res) => {
  const { unit_number, lease_id, issue_id, tenant_name, deposit_received,
          first_rent_received, note } = req.body ?? {};
  if (!unit_number) return res.status(400).json({ code: "UNIT_REQUIRED" });

  const signed = db.prepare(`SELECT ai.* FROM agreement_issues ai
    JOIN agreements ag ON ag.id = ai.agreement_id
    WHERE ai.unit_number=? AND ag.code='lease' AND ai.state='signed'
    ORDER BY ai.signed_at DESC LIMIT 1`).get(unit_number);
  if (!signed && !req.body?.override_note)
    return res.status(409).json({ code: "LEASE_NOT_SIGNED",
      detail: "No signed lease on file. Mark the agreement signed first, or give an override note." });

  const id = uid("kra_");
  db.prepare(`INSERT INTO key_release_approvals (id, unit_number, lease_id, issue_id,
    tenant_name, deposit_received, first_rent_received, lease_signed, approved_by,
    approved_name, approved_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(unit_number, lease_id) DO UPDATE SET deposit_received=excluded.deposit_received,
    first_rent_received=excluded.first_rent_received, approved_by=excluded.approved_by,
    approved_name=excluded.approved_name, approved_at=excluded.approved_at,
    note=excluded.note`)
    .run(id, unit_number, lease_id ?? null, issue_id ?? signed?.id ?? null,
         tenant_name ?? signed?.tenant_name ?? null, deposit_received ? 1 : 0,
         first_rent_received ? 1 : 0, signed ? 1 : 0, req.user.id, req.user.name,
         nowISO(), note ?? req.body?.override_note ?? null);

  // The Building Manager can only act once this exists, so telling them is
  // the point rather than a courtesy.
  notify("building_manager", "keys", "KEYS_RELEASED_FOR_BOOKING",
         { unit: unit_number, tenant: tenant_name ?? signed?.tenant_name ?? "" },
         `/site?keys=${unit_number}`);
  audit(req, { action: "keys.release", entityType: "unit", entityId: unit_number,
               after: { by: req.user.name, lease_signed: !!signed,
                        deposit: !!deposit_received, first_rent: !!first_rent_received } });
  res.status(201).json({ id, ok: true });
});

/* ================= User management ================= */

r.get("/admin/permissions/catalog", require_("users.manage"), (req, res) => {
  res.json({ permissions: Object.entries(PERMISSIONS)
    .map(([code, label]) => ({ code, label, group: code.split(".")[0] })) });
});

r.get("/admin/users/:id/permissions", require_("users.manage"), (req, res) => {
  const u = db.prepare("SELECT id, role_code FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ code: "USER_NOT_FOUND" });
  const grants = db.prepare("SELECT * FROM user_permissions WHERE user_id=?").all(u.id);
  res.json({
    role: u.role_code,
    effective: [...effectivePermissions(u.id, u.role_code)],
    overrides: grants,
  });
});

/** Grants and revokes on top of the role. Admin cannot change their own —
 *  the one account that can restore anything should not be able to lock
 *  itself out by mistake. */
r.post("/admin/users/:id/permissions", require_("users.manage"), (req, res) => {
  const { permission, effect, reason, expires_at } = req.body ?? {};
  if (!permission || !["grant", "revoke"].includes(effect))
    return res.status(400).json({ code: "INVALID_OVERRIDE" });
  if (!PERMISSIONS[permission]) return res.status(400).json({ code: "UNKNOWN_PERMISSION" });
  if (req.params.id === req.user.id)
    return res.status(409).json({ code: "CANNOT_MODIFY_SELF" });
  if (!reason?.trim()) return res.status(400).json({ code: "REASON_REQUIRED" });

  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ code: "USER_NOT_FOUND" });

  db.prepare(`INSERT INTO user_permissions (id, user_id, permission, effect, reason,
    granted_by, granted_name, expires_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, permission) DO UPDATE SET effect=excluded.effect,
    reason=excluded.reason, granted_by=excluded.granted_by,
    granted_name=excluded.granted_name, granted_at=datetime('now'),
    expires_at=excluded.expires_at`)
    .run(uid("up_"), u.id, permission, effect, reason.trim(), req.user.id, req.user.name,
         expires_at ?? null);

  // A permission change takes effect now, not when the session happens to
  // expire. Otherwise somebody keeps access they were just told they lost.
  db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL")
    .run(nowISO(), u.id);

  audit(req, { action: "user.permission", entityType: "user", entityId: u.id,
               after: { permission, effect, reason: reason.trim(), by: req.user.name } });
  res.json({ ok: true, sessions_revoked: true });
});

r.delete("/admin/users/:id/permissions/:permission", require_("users.manage"), (req, res) => {
  const before = db.prepare(`SELECT * FROM user_permissions WHERE user_id=? AND permission=?`)
    .get(req.params.id, req.params.permission);
  if (!before) return res.status(404).json({ code: "OVERRIDE_NOT_FOUND" });
  db.prepare("DELETE FROM user_permissions WHERE user_id=? AND permission=?")
    .run(req.params.id, req.params.permission);
  db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL")
    .run(nowISO(), req.params.id);
  audit(req, { action: "user.permission_clear", entityType: "user", entityId: req.params.id,
               before, after: { back_to_role_default: true } });
  res.json({ ok: true });
});

export default r;
