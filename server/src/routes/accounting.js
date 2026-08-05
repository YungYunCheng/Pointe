import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { db, uid, nowISO, txn, cents, addDays, daysBetween, fileHash, UPLOAD_DIR } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Accounting

   Two rules run through everything below.

   Every posting is balanced double entry, written through postEntry.
   Nothing edits a posted entry: a correction is a reversal plus a
   replacement, so the trail shows what happened rather than what
   somebody wishes had happened.

   A period that is closed rejects new postings. The monthly report is
   generated from closed figures only, which is what stops a report
   describing numbers that move afterwards.
   ============================================================ */

const period = (d) => String(d).slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** Refuses to post into a closed period, and refuses to post something
 *  that does not balance. Both are cheap checks that prevent expensive
 *  evenings later. */
function postEntry({ date, buildingCode, source, sourceId, memo, lines, userId }) {
  const p = period(date);
  const per = db.prepare("SELECT state FROM accounting_periods WHERE period = ?").get(p);
  if (per?.state === "closed")
    throw Object.assign(new Error("PERIOD_CLOSED"), { status: 409, period: p });

  const debits = cents(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const credits = cents(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (debits !== credits)
    throw Object.assign(new Error("ENTRY_UNBALANCED"), { status: 400, debits, credits });
  if (debits === 0)
    throw Object.assign(new Error("ENTRY_EMPTY"), { status: 400 });

  const id = uid("je_");
  const no = (db.prepare("SELECT COALESCE(MAX(entry_no),0) n FROM journal_entries").get().n) + 1;
  db.prepare(`INSERT INTO journal_entries (id, entry_no, entry_date, period, building_code,
    source, source_id, memo, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, no, date, p, buildingCode ?? null, source, sourceId ?? null, memo ?? null, userId ?? null);

  const insLine = db.prepare(`INSERT INTO journal_lines (id, entry_id, line_no, gl_code,
    debit, credit, building_code, unit_number, vendor_id, contact_id, memo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  lines.forEach((l, i) => insLine.run(uid("jl_"), id, i + 1, l.gl,
    cents(l.debit || 0), cents(l.credit || 0),
    l.buildingCode ?? buildingCode ?? null, l.unit ?? null,
    l.vendorId ?? null, l.contactId ?? null, l.memo ?? null));

  return { id, entry_no: no, total: debits };
}

/* ================= Chart of accounts ================= */

r.get("/coa", require_("accounting.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM gl_accounts ORDER BY code").all();
  const bal = db.prepare(`SELECT gl_code, SUM(debit) d, SUM(credit) c
                          FROM journal_lines GROUP BY gl_code`).all();
  const byCode = Object.fromEntries(bal.map((b) => [b.gl_code, b]));
  res.json({
    accounts: rows.map((a) => {
      const b = byCode[a.code] || { d: 0, c: 0 };
      // An account's balance sits on its normal side; showing a raw
      // debit-minus-credit makes every revenue line look negative.
      const balance = a.normal_side === "debit" ? cents(b.d - b.c) : cents(b.c - b.d);
      return { ...a, debits: cents(b.d), credits: cents(b.c), balance };
    }),
  });
});

r.post("/coa", require_("accounting.coa"), (req, res) => {
  const { code, name_en, name_zh, type, parent_code, normal_side, is_postable = 1 } = req.body ?? {};
  if (!code || !name_en || !type || !normal_side)
    return res.status(400).json({ code: "MISSING_ACCOUNT_FIELDS" });
  if (db.prepare("SELECT 1 FROM gl_accounts WHERE code = ?").get(code))
    return res.status(409).json({ code: "ACCOUNT_EXISTS" });
  db.prepare(`INSERT INTO gl_accounts (code, name_en, name_zh, type, parent_code,
    normal_side, is_postable) VALUES (?,?,?,?,?,?,?)`)
    .run(code, name_en, name_zh ?? name_en, type, parent_code ?? null, normal_side, is_postable ? 1 : 0);
  audit(req, { action: "coa.create", entityType: "gl_account", entityId: code, after: req.body });
  res.status(201).json({ code });
});

r.patch("/coa/:code", require_("accounting.coa"), (req, res) => {
  const before = db.prepare("SELECT * FROM gl_accounts WHERE code = ?").get(req.params.code);
  if (!before) return res.status(404).json({ code: "ACCOUNT_NOT_FOUND" });
  const used = db.prepare("SELECT COUNT(*) n FROM journal_lines WHERE gl_code = ?").get(req.params.code).n;
  // Renaming is fine. Changing type or side after it has been posted to would
  // rewrite the meaning of history.
  if (used > 0 && (req.body?.type || req.body?.normal_side))
    return res.status(409).json({ code: "ACCOUNT_IN_USE", entries: used });
  const { name_en, name_zh, is_active, note } = req.body ?? {};
  db.prepare(`UPDATE gl_accounts SET name_en=COALESCE(?,name_en), name_zh=COALESCE(?,name_zh),
    is_active=COALESCE(?,is_active), note=COALESCE(?,note) WHERE code=?`)
    .run(name_en ?? null, name_zh ?? null,
         is_active === undefined ? null : (is_active ? 1 : 0), note ?? null, req.params.code);
  audit(req, { action: "coa.update", entityType: "gl_account", entityId: req.params.code, before,
               after: req.body });
  res.json({ ok: true });
});

/* ================= Vendors ================= */

r.get("/vendors", require_("accounting.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM vendors ORDER BY name").all();
  const owing = db.prepare(`SELECT vendor_id, SUM(total - paid_amount) owed
    FROM ap_invoices WHERE state IN ('approved','partial') GROUP BY vendor_id`).all();
  const byV = Object.fromEntries(owing.map((o) => [o.vendor_id, cents(o.owed)]));
  res.json({ vendors: rows.map((v) => ({ ...v, outstanding: byV[v.id] ?? 0 })) });
});

r.post("/vendors", require_("accounting.ap"), (req, res) => {
  const { name } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ code: "VENDOR_NAME_REQUIRED" });
  const id = uid("vn_");
  const { contact, email, phone, address, gst_number, default_gl, payment_terms } = req.body;
  db.prepare(`INSERT INTO vendors (id, name, contact, email, phone, address, gst_number,
    default_gl, payment_terms) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, name.trim(), contact ?? null, email ?? null, phone ?? null, address ?? null,
         gst_number ?? null, default_gl ?? null, payment_terms ?? 30);
  audit(req, { action: "vendor.create", entityType: "vendor", entityId: id, after: { name } });
  res.status(201).json({ id });
});

/* ================= AP ================= */

r.get("/ap/invoices", require_("accounting.view"), (req, res) => {
  const { state, vendor_id, building } = req.query;
  let sql = `SELECT i.*, v.name vendor_name FROM ap_invoices i
             JOIN vendors v ON v.id = i.vendor_id WHERE 1=1`;
  const args = [];
  if (state) { sql += " AND i.state = ?"; args.push(state); }
  if (vendor_id) { sql += " AND i.vendor_id = ?"; args.push(vendor_id); }
  if (building) { sql += " AND i.building_code = ?"; args.push(building); }
  sql += " ORDER BY i.invoice_date DESC LIMIT 500";
  const rows = db.prepare(sql).all(...args);
  const lines = db.prepare("SELECT * FROM ap_invoice_lines ORDER BY line_no").all();
  res.json({ invoices: rows.map((i) => ({ ...i, lines: lines.filter((l) => l.invoice_id === i.id) })) });
});

r.post("/ap/invoices", require_("accounting.ap"), (req, res) => {
  const { vendor_id, invoice_no, invoice_date, due_date, building_code, unit_number,
          gst = 0, description, ticket_id, lines = [] } = req.body ?? {};
  if (!vendor_id || !invoice_no || !invoice_date || !lines.length)
    return res.status(400).json({ code: "MISSING_INVOICE_FIELDS" });

  // The unique index on (vendor, invoice_no) catches this too, but a clear
  // message beats a constraint error when someone keys the same bill twice.
  if (db.prepare("SELECT 1 FROM ap_invoices WHERE vendor_id=? AND invoice_no=?")
        .get(vendor_id, invoice_no))
    return res.status(409).json({ code: "DUPLICATE_INVOICE" });

  const subtotal = cents(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
  const total = cents(subtotal + Number(gst || 0));
  const vendor = db.prepare("SELECT * FROM vendors WHERE id = ?").get(vendor_id);
  const due = due_date || addDays(invoice_date, vendor?.payment_terms ?? 30);

  const id = uid("ap_");
  db.transaction(() => {
    db.prepare(`INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date, due_date,
      building_code, unit_number, subtotal, gst, total, description, ticket_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, vendor_id, invoice_no, invoice_date, due, building_code ?? null,
           unit_number ?? null, subtotal, cents(gst), total, description ?? null,
           ticket_id ?? null, req.user.id);
    const insL = db.prepare(`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
      description, amount, building_code, unit_number) VALUES (?,?,?,?,?,?,?,?)`);
    lines.forEach((l, i) => insL.run(uid("al_"), id, i + 1, l.gl_code, l.description ?? null,
      cents(l.amount), l.building_code ?? building_code ?? null, l.unit_number ?? unit_number ?? null));
  })();

  audit(req, { action: "ap.create", entityType: "ap_invoice", entityId: id,
               after: { vendor_id, invoice_no, total } });
  res.status(201).json({ id, subtotal, total, due_date: due });
});

/** Approving is what posts it. A draft invoice sits outside the ledger, so a
 *  bill entered by mistake never touches the accounts. */
r.post("/ap/invoices/:id/approve", require_("accounting.ap"), (req, res) => {
  try {
    const out = txn(() => {
      const inv = db.prepare("SELECT * FROM ap_invoices WHERE id = ?").get(req.params.id);
      if (!inv) throw Object.assign(new Error("INVOICE_NOT_FOUND"), { status: 404 });
      if (inv.state !== "draft") throw Object.assign(new Error("INVOICE_NOT_DRAFT"), { status: 409 });

      const lines = db.prepare("SELECT * FROM ap_invoice_lines WHERE invoice_id=? ORDER BY line_no")
                      .all(inv.id);
      const jl = lines.map((l) => ({ gl: l.gl_code, debit: l.amount,
        buildingCode: l.building_code, unit: l.unit_number, vendorId: inv.vendor_id,
        memo: l.description }));
      if (inv.gst > 0) jl.push({ gl: "1210", debit: inv.gst, vendorId: inv.vendor_id,
        memo: "GST input tax credit" });
      jl.push({ gl: "2010", credit: inv.total, vendorId: inv.vendor_id,
        buildingCode: inv.building_code, memo: `${inv.invoice_no}` });

      const entry = postEntry({ date: inv.invoice_date, buildingCode: inv.building_code,
        source: "ap_invoice", sourceId: inv.id,
        memo: `AP ${inv.invoice_no}`, lines: jl, userId: req.user.id });

      db.prepare(`UPDATE ap_invoices SET state='approved', entry_id=?, approved_by=?, approved_at=?
                  WHERE id=?`).run(entry.id, req.user.id, nowISO(), inv.id);
      return { entry_id: entry.id, entry_no: entry.entry_no, total: inv.total };
    })();
    audit(req, { action: "ap.approve", entityType: "ap_invoice", entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, ...e });
  }
});

r.post("/ap/payments", require_("accounting.ap"), (req, res) => {
  const { vendor_id, payment_date, method, reference, paid_from = "1010",
          applications = [] } = req.body ?? {};
  if (!vendor_id || !payment_date || !applications.length)
    return res.status(400).json({ code: "MISSING_PAYMENT_FIELDS" });

  try {
    const out = txn(() => {
      let total = 0;
      for (const a of applications) {
        const inv = db.prepare("SELECT * FROM ap_invoices WHERE id=?").get(a.invoice_id);
        if (!inv) throw Object.assign(new Error("INVOICE_NOT_FOUND"), { status: 404 });
        if (!["approved", "partial"].includes(inv.state))
          throw Object.assign(new Error("INVOICE_NOT_PAYABLE"), { status: 409 });
        const owing = cents(inv.total - inv.paid_amount);
        if (cents(a.amount) > owing)
          throw Object.assign(new Error("OVERPAYMENT"), { status: 400, owing });
        total = cents(total + Number(a.amount));
      }

      const id = uid("pay_");
      const no = (db.prepare("SELECT COALESCE(MAX(payment_no),0) n FROM ap_payments").get().n) + 1;
      const entry = postEntry({ date: payment_date, source: "ap_payment", sourceId: id,
        memo: `Vendor payment ${no}`, userId: req.user.id,
        lines: [{ gl: "2010", debit: total, vendorId: vendor_id },
                { gl: paid_from, credit: total }] });

      db.prepare(`INSERT INTO ap_payments (id, payment_no, vendor_id, payment_date, amount,
        method, reference, paid_from, entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, no, vendor_id, payment_date, total, method ?? "etransfer",
             reference ?? null, paid_from, entry.id, req.user.id);

      const insA = db.prepare(`INSERT INTO ap_applications (id, payment_id, invoice_id, amount)
                               VALUES (?,?,?,?)`);
      for (const a of applications) {
        insA.run(uid("apa_"), id, a.invoice_id, cents(a.amount));
        const inv = db.prepare("SELECT * FROM ap_invoices WHERE id=?").get(a.invoice_id);
        const paid = cents(inv.paid_amount + Number(a.amount));
        db.prepare("UPDATE ap_invoices SET paid_amount=?, state=? WHERE id=?")
          .run(paid, paid >= cents(inv.total) ? "paid" : "partial", a.invoice_id);
      }
      return { id, payment_no: no, amount: total, entry_id: entry.id };
    })();
    audit(req, { action: "ap.pay", entityType: "ap_payment", entityId: out.id, after: out });
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, owing: e.owing });
  }
});

/* ================= Charge schedules ================= */

r.get("/schedules", require_("accounting.view"), (req, res) => {
  res.json({ schedules: db.prepare(`SELECT cs.*, l.end_date lease_end, l.term_type
    FROM charge_schedules cs LEFT JOIN leases l ON l.id = cs.lease_id
    WHERE cs.is_active = 1 ORDER BY cs.unit_number, cs.kind`).all() });
});

r.post("/schedules", require_("accounting.ar"), (req, res) => {
  const { lease_id, unit_number, contact_id, kind, gl_code, amount,
          charge_day = 1, due_day = 1, start_date, end_date, prorate_first = 1 } = req.body ?? {};
  if (!unit_number || !kind || !gl_code || !amount || !start_date)
    return res.status(400).json({ code: "MISSING_SCHEDULE_FIELDS" });
  if (charge_day < 1 || charge_day > 28)
    return res.status(400).json({ code: "CHARGE_DAY_OUT_OF_RANGE" });

  const id = uid("cs_");
  db.prepare(`INSERT INTO charge_schedules (id, lease_id, unit_number, contact_id, kind,
    gl_code, amount, charge_day, due_day, start_date, end_date, prorate_first, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, lease_id ?? null, unit_number, contact_id ?? null, kind, gl_code, cents(amount),
         charge_day, due_day, start_date, end_date ?? null, prorate_first ? 1 : 0, req.user.id);
  audit(req, { action: "schedule.create", entityType: "charge_schedule", entityId: id,
               after: { unit_number, kind, amount, charge_day } });
  res.status(201).json({ id });
});

r.patch("/schedules/:id", require_("accounting.ar"), (req, res) => {
  const before = db.prepare("SELECT * FROM charge_schedules WHERE id=?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "SCHEDULE_NOT_FOUND" });
  const { amount, charge_day, due_day, end_date, is_active, note } = req.body ?? {};
  if (charge_day != null && (charge_day < 1 || charge_day > 28))
    return res.status(400).json({ code: "CHARGE_DAY_OUT_OF_RANGE" });
  db.prepare(`UPDATE charge_schedules SET amount=COALESCE(?,amount),
    charge_day=COALESCE(?,charge_day), due_day=COALESCE(?,due_day),
    end_date=COALESCE(?,end_date), is_active=COALESCE(?,is_active), note=COALESCE(?,note)
    WHERE id=?`)
    .run(amount == null ? null : cents(amount), charge_day ?? null, due_day ?? null,
         end_date ?? null, is_active === undefined ? null : (is_active ? 1 : 0),
         note ?? null, req.params.id);
  audit(req, { action: "schedule.update", entityType: "charge_schedule", entityId: req.params.id,
               before, after: req.body });
  res.json({ ok: true });
});

/* ================= Rent run ================= */

/** Generates the month's charges. Safe to run twice: the unique index on
 *  (schedule, period) means a second run adds nothing rather than
 *  double-billing 330 tenants. */
export function runRent(targetPeriod, userId, buildingCode = null) {
  const [y, m] = targetPeriod.split("-").map(Number);
  const monthStart = `${targetPeriod}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthEnd = `${targetPeriod}-${String(daysInMonth).padStart(2, "0")}`;

  const rows = db.prepare(`
    SELECT cs.*, u.building_code FROM charge_schedules cs
    JOIN units u ON u.unit_number = cs.unit_number
    WHERE cs.is_active = 1 AND cs.start_date <= ?
      AND (cs.end_date IS NULL OR cs.end_date >= ?)
      ${buildingCode ? "AND u.building_code = ?" : ""}
  `).all(...(buildingCode ? [monthEnd, monthStart, buildingCode] : [monthEnd, monthStart]));

  const created = [], skipped = [];
  const run = db.transaction(() => {
    for (const s of rows) {
      const exists = db.prepare("SELECT 1 FROM ar_charges WHERE schedule_id=? AND period=?")
                       .get(s.id, targetPeriod);
      if (exists) { skipped.push(s.unit_number); continue; }

      // A tenancy starting or ending mid-month is billed for the days it covers.
      // Charging a full month either way is the kind of small unfairness that
      // turns into a dispute over forty dollars.
      let amount = s.amount, prorated = 0, note = null;
      const startsThisMonth = s.start_date > monthStart && s.start_date <= monthEnd;
      const endsThisMonth = s.end_date && s.end_date >= monthStart && s.end_date < monthEnd;

      if (s.prorate_first && startsThisMonth) {
        const days = daysBetween(s.start_date, monthEnd) + 1;
        amount = cents(s.amount * days / daysInMonth);
        prorated = 1;
        note = `${days}/${daysInMonth} days from ${s.start_date} — ${s.amount} × ${days} ÷ ${daysInMonth}`;
      } else if (endsThisMonth) {
        const days = daysBetween(monthStart, s.end_date) + 1;
        amount = cents(s.amount * days / daysInMonth);
        prorated = 1;
        note = `${days}/${daysInMonth} days to ${s.end_date} — ${s.amount} × ${days} ÷ ${daysInMonth}`;
      }
      if (amount <= 0) { skipped.push(s.unit_number); continue; }

      const chargeDate = `${targetPeriod}-${String(s.charge_day).padStart(2, "0")}`;
      const dueDate = `${targetPeriod}-${String(s.due_day).padStart(2, "0")}`;
      const id = uid("arc_");

      const entry = postEntry({
        date: chargeDate, buildingCode: s.building_code, source: "rent_run", sourceId: id,
        memo: `${s.kind} ${s.unit_number} ${targetPeriod}`, userId,
        lines: [{ gl: "1100", debit: amount, unit: s.unit_number, contactId: s.contact_id,
                  buildingCode: s.building_code },
                { gl: s.gl_code, credit: amount, unit: s.unit_number,
                  buildingCode: s.building_code }],
      });

      db.prepare(`INSERT INTO ar_charges (id, schedule_id, lease_id, unit_number, contact_id,
        building_code, period, kind, gl_code, description, amount, prorated, prorate_note,
        charge_date, due_date, entry_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, s.id, s.lease_id, s.unit_number, s.contact_id, s.building_code, targetPeriod,
             s.kind, s.gl_code, `${s.kind} ${targetPeriod}`, amount, prorated, note,
             chargeDate, dueDate, entry.id);
      created.push({ unit: s.unit_number, kind: s.kind, amount, prorated: !!prorated });
    }
  });
  run();
  return { period: targetPeriod, created: created.length, skipped: skipped.length,
           total: cents(created.reduce((t, c) => t + c.amount, 0)), charges: created };
}

r.post("/ar/run", require_("accounting.ar"), (req, res) => {
  const p = req.body?.period || period(today());
  try {
    const out = runRent(p, req.user.id, req.body?.building_code ?? null);
    audit(req, { action: "ar.run", entityType: "period", entityId: p, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, period: e.period });
  }
});

/** Preview shows what a run would do without posting. Worth having before
 *  anything hits 330 ledgers. */
r.get("/ar/run/preview", require_("accounting.view"), (req, res) => {
  const p = req.query.period || period(today());
  const [y, m] = p.split("-").map(Number);
  const dim = new Date(y, m, 0).getDate();
  const rows = db.prepare(`SELECT cs.*, u.building_code FROM charge_schedules cs
    JOIN units u ON u.unit_number = cs.unit_number
    WHERE cs.is_active = 1 AND cs.start_date <= ? AND (cs.end_date IS NULL OR cs.end_date >= ?)`)
    .all(`${p}-${String(dim).padStart(2, "0")}`, `${p}-01`);
  const already = new Set(db.prepare("SELECT schedule_id FROM ar_charges WHERE period=?")
                            .all(p).map((x) => x.schedule_id));
  const pending = rows.filter((s) => !already.has(s.id));
  res.json({ period: p, would_create: pending.length, already_billed: already.size,
             estimated_total: cents(pending.reduce((t, s) => t + s.amount, 0)),
             by_building: pending.reduce((a, s) => {
               a[s.building_code] = cents((a[s.building_code] || 0) + s.amount); return a; }, {}) });
});

/* ================= AR receipts ================= */

r.get("/ar/charges", require_("accounting.view"), (req, res) => {
  const { state, unit, period: p, building, overdue } = req.query;
  let sql = "SELECT * FROM ar_charges WHERE 1=1";
  const args = [];
  if (state) { sql += " AND state = ?"; args.push(state); }
  if (unit) { sql += " AND unit_number = ?"; args.push(unit); }
  if (p) { sql += " AND period = ?"; args.push(p); }
  if (building) { sql += " AND building_code = ?"; args.push(building); }
  if (overdue === "1") { sql += " AND state IN ('open','partial') AND due_date < date('now')"; }
  sql += " ORDER BY due_date DESC, unit_number LIMIT 1000";
  const rows = db.prepare(sql).all(...args);
  res.json({ charges: rows.map((c) => ({ ...c, outstanding: cents(c.amount - c.paid_amount) })),
             total_outstanding: cents(rows.reduce((t, c) => t + (c.amount - c.paid_amount), 0)) });
});

r.post("/ar/receipts", require_("accounting.ar"), (req, res) => {
  const { unit_number, contact_id, received_date, amount, method, reference,
          deposit_to = "1010", applications = [], note } = req.body ?? {};
  if (!received_date || !amount) return res.status(400).json({ code: "MISSING_RECEIPT_FIELDS" });

  try {
    const out = txn(() => {
      const total = cents(amount);
      const applied = cents(applications.reduce((s, a) => s + Number(a.amount || 0), 0));
      if (applied > total) throw Object.assign(new Error("APPLIED_EXCEEDS_RECEIPT"), { status: 400 });

      const unit = unit_number
        ? db.prepare("SELECT building_code FROM units WHERE unit_number=?").get(unit_number) : null;
      const id = uid("rc_");
      const no = (db.prepare("SELECT COALESCE(MAX(receipt_no),0) n FROM ar_receipts").get().n) + 1;

      const lines = [{ gl: deposit_to, debit: total, unit: unit_number,
                       buildingCode: unit?.building_code }];
      if (applied > 0) lines.push({ gl: "1100", credit: applied, unit: unit_number,
                                    contactId: contact_id, buildingCode: unit?.building_code });
      // Money in beyond what is owed is the tenant's, not ours. It sits in
      // prepaid rent until a charge exists to apply it to.
      const unapplied = cents(total - applied);
      if (unapplied > 0) lines.push({ gl: "2200", credit: unapplied, unit: unit_number,
                                      contactId: contact_id, memo: "Prepaid rent" });

      const entry = postEntry({ date: received_date, buildingCode: unit?.building_code,
        source: "ar_receipt", sourceId: id, memo: `Receipt ${no} ${unit_number ?? ""}`,
        lines, userId: req.user.id });

      db.prepare(`INSERT INTO ar_receipts (id, receipt_no, unit_number, contact_id, building_code,
        received_date, amount, method, reference, deposit_to, entry_id, note, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, no, unit_number ?? null, contact_id ?? null, unit?.building_code ?? null,
             received_date, total, method ?? "etransfer", reference ?? null, deposit_to,
             entry.id, note ?? null, req.user.id);

      const insA = db.prepare(`INSERT INTO ar_applications (id, receipt_id, charge_id, amount)
                               VALUES (?,?,?,?)`);
      for (const a of applications) {
        const ch = db.prepare("SELECT * FROM ar_charges WHERE id=?").get(a.charge_id);
        if (!ch) throw Object.assign(new Error("CHARGE_NOT_FOUND"), { status: 404 });
        const owing = cents(ch.amount - ch.paid_amount);
        if (cents(a.amount) > owing)
          throw Object.assign(new Error("OVERAPPLIED"), { status: 400, charge: ch.id, owing });
        insA.run(uid("ara_"), id, a.charge_id, cents(a.amount));
        const paid = cents(ch.paid_amount + Number(a.amount));
        db.prepare("UPDATE ar_charges SET paid_amount=?, state=? WHERE id=?")
          .run(paid, paid >= cents(ch.amount) ? "paid" : "partial", a.charge_id);
      }
      return { id, receipt_no: no, amount: total, applied, unapplied, entry_id: entry.id };
    })();
    audit(req, { action: "ar.receipt", entityType: "ar_receipt", entityId: out.id, after: out });
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, owing: e.owing });
  }
});

/* ================= Deposits held in trust ================= */

/** Deposits go to the trust account, never to revenue. The credit is a
 *  liability because the money belongs to the tenant until they leave. */
r.post("/deposits/receive", require_("accounting.ar"), (req, res) => {
  const { unit_number, contact_id, lease_id, amount, txn_date, reference } = req.body ?? {};
  if (!unit_number || !amount) return res.status(400).json({ code: "MISSING_DEPOSIT_FIELDS" });
  try {
    const out = txn(() => {
      const u = db.prepare("SELECT building_code FROM units WHERE unit_number=?").get(unit_number);
      const id = uid("dl_");
      const entry = postEntry({ date: txn_date || today(), buildingCode: u?.building_code,
        source: "deposit", sourceId: id, memo: `Deposit received ${unit_number}`,
        userId: req.user.id,
        lines: [{ gl: "1020", debit: cents(amount), unit: unit_number },
                { gl: "2100", credit: cents(amount), unit: unit_number, contactId: contact_id }] });
      db.prepare(`INSERT INTO deposit_ledger (id, lease_id, unit_number, contact_id, building_code,
        kind, amount, txn_date, entry_id, created_by) VALUES (?,?,?,?,?,'received',?,?,?,?)`)
        .run(id, lease_id ?? null, unit_number, contact_id ?? null, u?.building_code ?? null,
             cents(amount), txn_date || today(), entry.id, req.user.id);
      return { id, amount: cents(amount), entry_id: entry.id };
    })();
    audit(req, { action: "deposit.receive", entityType: "deposit", entityId: out.id, after: out });
    res.status(201).json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/** Interest accrual. The rate is a setting because it changes; without this
 *  every refund is short by the interest owed. */
r.post("/deposits/accrue-interest", require_("accounting.post"), (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const rate = db.prepare("SELECT * FROM deposit_interest_rates WHERE year = ?").get(year);
  if (!rate) return res.status(400).json({ code: "INTEREST_RATE_NOT_SET", year });

  const balances = db.prepare(`SELECT unit_number, contact_id, building_code,
    SUM(amount) bal FROM deposit_ledger GROUP BY unit_number HAVING bal > 0`).all();

  const out = [];
  const run = db.transaction(() => {
    for (const b of balances) {
      const interest = cents(b.bal * rate.rate);
      if (interest <= 0) continue;
      const id = uid("dl_");
      const entry = postEntry({ date: `${year}-12-31`, buildingCode: b.building_code,
        source: "deposit", sourceId: id, memo: `Deposit interest ${year} ${b.unit_number}`,
        userId: req.user.id,
        lines: [{ gl: "5100", debit: interest, unit: b.unit_number },
                { gl: "2110", credit: interest, unit: b.unit_number, contactId: b.contact_id }] });
      db.prepare(`INSERT INTO deposit_ledger (id, unit_number, contact_id, building_code, kind,
        amount, txn_date, basis, entry_id, created_by)
        VALUES (?,?,?,?,'interest',?,?,?,?,?)`)
        .run(id, b.unit_number, b.contact_id, b.building_code, interest, `${year}-12-31`,
             `${b.bal} × ${rate.rate} (${year} rate)`, entry.id, req.user.id);
      out.push({ unit: b.unit_number, base: cents(b.bal), interest });
    }
  });
  run();
  audit(req, { action: "deposit.interest", entityType: "period", entityId: String(year),
               after: { count: out.length, total: cents(out.reduce((t, x) => t + x.interest, 0)) } });
  res.json({ year, rate: rate.rate, accrued: out.length,
             total: cents(out.reduce((t, x) => t + x.interest, 0)), detail: out });
});

r.get("/deposits", require_("accounting.view"), (req, res) => {
  const rows = db.prepare(`SELECT unit_number, building_code,
    SUM(CASE WHEN kind='received' THEN amount ELSE 0 END) received,
    SUM(CASE WHEN kind='interest' THEN amount ELSE 0 END) interest,
    SUM(CASE WHEN kind='deduction' THEN amount ELSE 0 END) deductions,
    SUM(CASE WHEN kind='refund' THEN amount ELSE 0 END) refunded,
    SUM(amount) balance FROM deposit_ledger GROUP BY unit_number ORDER BY unit_number`).all();
  const trust = db.prepare(`SELECT SUM(debit)-SUM(credit) bal FROM journal_lines
                            WHERE gl_code='1020'`).get().bal || 0;
  const owed = cents(rows.reduce((t, x) => t + x.balance, 0));
  res.json({
    deposits: rows.map((x) => ({ ...x, balance: cents(x.balance) })),
    total_held: owed,
    trust_account_balance: cents(trust),
    // These two must agree. If they do not, the trust account has been used
    // for something it should not have been.
    in_agreement: cents(trust) === owed,
  });
});

/* ================= Transaction search ================= */

/** One search across the ledger, receipts and invoices. Free text matches a
 *  vendor, a tenant, a unit or a reference; a number matches an amount within
 *  a cent, which is how you find "that $1,847 payment" without a date. */
r.get("/search", require_("accounting.view"), (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const { from, to, building, gl, limit = 200 } = req.query;
  if (!q && !from && !gl) return res.json({ results: [], total: 0 });

  const num = Number(q.replace(/[$,]/g, ""));
  const isAmount = q !== "" && Number.isFinite(num);
  const like = `%${q}%`;
  const n = Math.min(Number(limit) || 200, 1000);

  const rows = db.prepare(`
    SELECT
      je.id, je.entry_no, je.entry_date, je.period, je.source, je.memo,
      je.building_code, jl.gl_code, ga.name_en gl_name, ga.name_zh gl_name_zh,
      jl.debit, jl.credit, jl.unit_number, jl.vendor_id, v.name vendor_name,
      jl.memo line_memo
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN gl_accounts ga ON ga.code = jl.gl_code
    LEFT JOIN vendors v ON v.id = jl.vendor_id
    WHERE je.state = 'posted'
      ${from ? "AND je.entry_date >= @from" : ""}
      ${to ? "AND je.entry_date <= @to" : ""}
      ${building ? "AND je.building_code = @building" : ""}
      ${gl ? "AND jl.gl_code = @gl" : ""}
      ${q ? `AND (
        jl.unit_number LIKE @like
        OR v.name LIKE @like
        OR je.memo LIKE @like
        OR jl.memo LIKE @like
        OR ga.name_en LIKE @like
        OR ga.name_zh LIKE @like
        OR jl.gl_code LIKE @like
        ${isAmount ? "OR ABS(jl.debit - @num) < 0.005 OR ABS(jl.credit - @num) < 0.005" : ""}
      )` : ""}
    ORDER BY je.entry_date DESC, je.entry_no DESC
    LIMIT @n
  `).all({ from, to, building, gl, like, num: isAmount ? num : 0, n });

  // Tenant names live with contacts, not on the ledger, so they are resolved
  // here rather than denormalised into every line.
  const names = {};
  if (q) {
    for (const c of db.prepare("SELECT id, full_name FROM contacts WHERE full_name LIKE ?").all(like))
      names[c.id] = c.full_name;
  }

  res.json({
    results: rows.map((x) => ({ ...x, debit: cents(x.debit), credit: cents(x.credit) })),
    total: rows.length,
    matched_amount: isAmount ? num : null,
    contacts: Object.entries(names).map(([id, name]) => ({ id, name })),
  });
});

/* ================= Banking ================= */

const upload = multer({ storage: multer.memoryStorage(),
                        limits: { fileSize: 15 * 1024 * 1024 } });

r.post("/bank/statements", require_("accounting.bank"), upload.single("file"), (req, res) => {
  const { gl_code, period: p, start_date, end_date, opening_balance, closing_balance,
          transactions } = req.body ?? {};
  if (!gl_code || !p || !start_date || !end_date)
    return res.status(400).json({ code: "MISSING_STATEMENT_FIELDS" });
  if (db.prepare("SELECT 1 FROM bank_statements WHERE gl_code=? AND period=?").get(gl_code, p))
    return res.status(409).json({ code: "STATEMENT_EXISTS" });

  let stored = null, hash = null;
  if (req.file) {
    hash = fileHash(req.file.buffer);
    const dir = path.join(UPLOAD_DIR, "bank");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${p}_${gl_code}_${hash.slice(0, 8)}_${req.file.originalname.replace(/[^\w.\-]/g, "_")}`;
    fs.writeFileSync(path.join(dir, name), req.file.buffer);
    stored = path.join("bank", name);
  }

  const id = uid("bs_");
  const txns = typeof transactions === "string" ? JSON.parse(transactions || "[]") : (transactions || []);
  db.transaction(() => {
    db.prepare(`INSERT INTO bank_statements (id, gl_code, period, start_date, end_date,
      opening_balance, closing_balance, filename, stored_path, sha256, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, gl_code, p, start_date, end_date, cents(opening_balance || 0),
           cents(closing_balance || 0), req.file?.originalname ?? null, stored, hash, req.user.id);
    const insT = db.prepare(`INSERT INTO bank_transactions (id, statement_id, txn_date,
      description, debit, credit, balance) VALUES (?,?,?,?,?,?,?)`);
    for (const t of txns) insT.run(uid("bt_"), id, t.date, t.description ?? null,
      cents(t.debit || 0), cents(t.credit || 0), t.balance == null ? null : cents(t.balance));
  })();

  audit(req, { action: "bank.upload", entityType: "bank_statement", entityId: id,
               after: { gl_code, period: p, transactions: txns.length, sha256: hash } });
  res.status(201).json({ id, transactions: txns.length });
});

r.get("/bank/statements", require_("accounting.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM bank_statements ORDER BY period DESC").all();
  const counts = db.prepare(`SELECT statement_id,
    COUNT(*) total, SUM(CASE WHEN matched_id IS NULL THEN 1 ELSE 0 END) unmatched
    FROM bank_transactions GROUP BY statement_id`).all();
  const byS = Object.fromEntries(counts.map((c) => [c.statement_id, c]));
  res.json({ statements: rows.map((s) => ({ ...s, ...(byS[s.id] ?? { total: 0, unmatched: 0 }) })) });
});

r.get("/bank/statements/:id", require_("accounting.view"), (req, res) => {
  const st = db.prepare("SELECT * FROM bank_statements WHERE id=?").get(req.params.id);
  if (!st) return res.status(404).json({ code: "STATEMENT_NOT_FOUND" });
  const txns = db.prepare("SELECT * FROM bank_transactions WHERE statement_id=? ORDER BY txn_date")
                 .all(st.id);

  // Suggested matches: same amount, within a few days. Suggestions only —
  // the person reconciling decides, because a coincidence of amount and date
  // is common in rent.
  const suggest = (t) => {
    if (t.matched_id) return [];
    if (t.credit > 0) {
      return db.prepare(`SELECT id, receipt_no, received_date, amount, unit_number, reference
        FROM ar_receipts WHERE bank_txn_id IS NULL AND ABS(amount - ?) < 0.005
          AND ABS(julianday(received_date) - julianday(?)) <= 5 LIMIT 5`)
        .all(t.credit, t.txn_date).map((x) => ({ type: "ar_receipt", ...x }));
    }
    return db.prepare(`SELECT id, payment_no, payment_date, amount, reference
      FROM ap_payments WHERE bank_txn_id IS NULL AND ABS(amount - ?) < 0.005
        AND ABS(julianday(payment_date) - julianday(?)) <= 5 LIMIT 5`)
      .all(t.debit, t.txn_date).map((x) => ({ type: "ap_payment", ...x }));
  };

  const ledger = db.prepare(`SELECT SUM(debit)-SUM(credit) bal FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.gl_code=? AND je.entry_date <= ?`).get(st.gl_code, st.end_date).bal || 0;

  res.json({
    statement: st,
    transactions: txns.map((t) => ({ ...t, suggestions: suggest(t) })),
    ledger_balance: cents(ledger),
    statement_balance: cents(st.closing_balance),
    difference: cents(st.closing_balance - ledger),
  });
});

r.post("/bank/transactions/:id/match", require_("accounting.bank"), (req, res) => {
  const { matched_type, matched_id } = req.body ?? {};
  const t = db.prepare("SELECT * FROM bank_transactions WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ code: "TXN_NOT_FOUND" });

  db.transaction(() => {
    db.prepare(`UPDATE bank_transactions SET matched_type=?, matched_id=?, matched_by=?, matched_at=?
                WHERE id=?`).run(matched_type, matched_id, req.user.id, nowISO(), t.id);
    if (matched_type === "ar_receipt")
      db.prepare("UPDATE ar_receipts SET bank_txn_id=? WHERE id=?").run(t.id, matched_id);
    if (matched_type === "ap_payment")
      db.prepare("UPDATE ap_payments SET bank_txn_id=? WHERE id=?").run(t.id, matched_id);
  })();
  audit(req, { action: "bank.match", entityType: "bank_transaction", entityId: t.id,
               after: { matched_type, matched_id } });
  res.json({ ok: true });
});

/** Reconciling requires the statement to agree with the ledger. Allowing a
 *  reconciliation "with a small difference" is how a difference becomes
 *  permanent. */
r.post("/bank/statements/:id/reconcile", require_("accounting.close"), (req, res) => {
  const st = db.prepare("SELECT * FROM bank_statements WHERE id=?").get(req.params.id);
  if (!st) return res.status(404).json({ code: "STATEMENT_NOT_FOUND" });

  const unmatched = db.prepare(`SELECT COUNT(*) n FROM bank_transactions
    WHERE statement_id=? AND matched_id IS NULL`).get(st.id).n;
  if (unmatched > 0) return res.status(409).json({ code: "UNMATCHED_TRANSACTIONS", unmatched });

  const ledger = db.prepare(`SELECT SUM(debit)-SUM(credit) bal FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.gl_code=? AND je.entry_date <= ?`).get(st.gl_code, st.end_date).bal || 0;
  const diff = cents(st.closing_balance - ledger);
  if (Math.abs(diff) >= 0.01)
    return res.status(409).json({ code: "BALANCE_MISMATCH", difference: diff,
                                  ledger: cents(ledger), statement: cents(st.closing_balance) });

  db.prepare(`UPDATE bank_statements SET state='reconciled', reconciled_by=?, reconciled_at=?
              WHERE id=?`).run(req.user.id, nowISO(), st.id);
  audit(req, { action: "bank.reconcile", entityType: "bank_statement", entityId: st.id,
               after: { period: st.period, gl_code: st.gl_code } });
  res.json({ ok: true, period: st.period });
});

/* ================= Period close ================= */

r.get("/periods", require_("accounting.view"), (req, res) => {
  res.json({ periods: db.prepare("SELECT * FROM accounting_periods ORDER BY period DESC").all() });
});

r.post("/periods/:period/reconcile", require_("accounting.close"), (req, res) => {
  const p = req.params.period;
  const open = db.prepare(`SELECT COUNT(*) n FROM bank_statements
    WHERE period=? AND state <> 'reconciled'`).get(p).n;
  const none = db.prepare("SELECT COUNT(*) n FROM bank_statements WHERE period=?").get(p).n;
  if (none === 0) return res.status(409).json({ code: "NO_STATEMENTS", period: p });
  if (open > 0) return res.status(409).json({ code: "STATEMENTS_NOT_RECONCILED", outstanding: open });

  db.prepare(`INSERT INTO accounting_periods (period, state, reconciled_by, reconciled_at)
    VALUES (?, 'reconciled', ?, ?)
    ON CONFLICT(period) DO UPDATE SET state='reconciled', reconciled_by=excluded.reconciled_by,
    reconciled_at=excluded.reconciled_at`).run(p, req.user.id, nowISO());
  audit(req, { action: "period.reconcile", entityType: "period", entityId: p });
  notify("admin", "accounting", "PERIOD_RECONCILED", { period: p }, `/accounting/reports?period=${p}`);
  res.json({ ok: true, period: p });
});

r.post("/periods/:period/close", require_("accounting.close"), (req, res) => {
  const p = req.params.period;
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(p);
  if (per?.state !== "reconciled")
    return res.status(409).json({ code: "PERIOD_NOT_RECONCILED", state: per?.state ?? "open" });
  db.prepare("UPDATE accounting_periods SET state='closed', closed_by=?, closed_at=? WHERE period=?")
    .run(req.user.id, nowISO(), p);
  audit(req, { action: "period.close", entityType: "period", entityId: p });
  res.json({ ok: true, period: p });
});

/* ================= Financial figures ================= */

/** The numbers behind a monthly report. Computed here, in SQL, from posted
 *  entries. The AI writes the narrative from this and never recalculates it. */
export function periodFigures(p, buildingCode) {
  const where = buildingCode ? "AND je.building_code = ?" : "";
  const args = buildingCode ? [p, buildingCode] : [p];

  const byAccount = db.prepare(`
    SELECT ga.code, ga.name_en, ga.name_zh, ga.type, ga.normal_side,
           SUM(jl.debit) d, SUM(jl.credit) c
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN gl_accounts ga ON ga.code = jl.gl_code
    WHERE je.period = ? AND je.state = 'posted' ${where}
    GROUP BY ga.code ORDER BY ga.code`).all(...args);

  const amount = (a) => (a.normal_side === "debit" ? cents(a.d - a.c) : cents(a.c - a.d));
  const revenue = byAccount.filter((a) => a.type === "revenue").map((a) => ({ ...a, amount: amount(a) }));
  const expense = byAccount.filter((a) => a.type === "expense").map((a) => ({ ...a, amount: amount(a) }));
  const revenueTotal = cents(revenue.reduce((t, a) => t + a.amount, 0));
  const expenseTotal = cents(expense.reduce((t, a) => t + a.amount, 0));

  const billed = db.prepare(`SELECT SUM(amount) t, COUNT(*) n FROM ar_charges
    WHERE period=? ${buildingCode ? "AND building_code=?" : ""}`).get(...args);
  const collected = db.prepare(`SELECT SUM(amount) t FROM ar_receipts
    WHERE strftime('%Y-%m', received_date)=? ${buildingCode ? "AND building_code=?" : ""}`).get(...args);
  const arrears = db.prepare(`SELECT SUM(amount - paid_amount) t, COUNT(*) n FROM ar_charges
    WHERE state IN ('open','partial') AND due_date < date('now')
    ${buildingCode ? "AND building_code=?" : ""}`).get(...(buildingCode ? [buildingCode] : []));

  const occ = db.prepare(`SELECT status, COUNT(*) n FROM units
    ${buildingCode ? "WHERE building_code=?" : ""} GROUP BY status`)
    .all(...(buildingCode ? [buildingCode] : []));
  const totalUnits = occ.reduce((t, o) => t + o.n, 0);
  const occupied = occ.filter((o) => ["occupied", "signed"].includes(o.status))
                      .reduce((t, o) => t + o.n, 0);

  const billedTotal = cents(billed?.t || 0);
  const collectedTotal = cents(collected?.t || 0);

  return {
    period: p,
    building: buildingCode ?? "all",
    revenue, expense,
    revenue_total: revenueTotal,
    expense_total: expenseTotal,
    net_operating_income: cents(revenueTotal - expenseTotal),
    rent_billed: billedTotal,
    rent_collected: collectedTotal,
    // Collection can exceed 100% in a month where arrears are cleared. That is
    // a real result, not an error, so it is not capped.
    collection_rate: billedTotal > 0 ? Number((collectedTotal / billedTotal * 100).toFixed(1)) : null,
    charges_raised: billed?.n || 0,
    arrears_total: cents(arrears?.t || 0),
    arrears_count: arrears?.n || 0,
    units_total: totalUnits,
    units_occupied: occupied,
    occupancy_rate: totalUnits > 0 ? Number((occupied / totalUnits * 100).toFixed(1)) : null,
  };
}

export function figuresMethod(f) {
  return [
    `Revenue: sum of credits less debits on revenue accounts, posted entries in ${f.period}${f.building !== "all" ? `, building ${f.building}` : ""}.`,
    `Expenses: sum of debits less credits on expense accounts, same basis.`,
    `Net operating income: revenue ${f.revenue_total} less expenses ${f.expense_total} = ${f.net_operating_income}. Accrual basis, so it counts what was billed and incurred, not what moved through the bank.`,
    `Rent billed: ${f.charges_raised} charges raised for the period, totalling ${f.rent_billed}.`,
    `Rent collected: receipts dated within the period, totalling ${f.rent_collected}. A receipt for an earlier month counts here, which is why collection can exceed 100%.`,
    f.collection_rate == null ? `Collection rate: not calculable, nothing billed.`
      : `Collection rate: ${f.rent_collected} ÷ ${f.rent_billed} = ${f.collection_rate}%.`,
    `Arrears: charges still open or partly paid with a due date already past, totalling ${f.arrears_total} across ${f.arrears_count} charges. This is a running figure, not confined to the period.`,
    `Occupancy: ${f.units_occupied} of ${f.units_total} units occupied or signed = ${f.occupancy_rate}%. Counted at the time of generation, not averaged over the month.`,
  ].join("\n");
}

r.get("/figures", require_("accounting.view"), (req, res) => {
  const p = req.query.period || period(today());
  const f = periodFigures(p, req.query.building || null);
  res.json({ figures: f, method: figuresMethod(f) });
});

/* ================= Monthly reports ================= */

r.get("/reports", require_("accounting.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM monthly_reports ORDER BY period DESC, building_code").all();
  res.json({ reports: rows.map((x) => ({ ...x, figures: JSON.parse(x.figures) })) });
});

/** Generated per building, and only once the period is reconciled. A report
 *  written from open figures describes numbers that are still moving. */
r.post("/reports/generate", require_("accounting.reports"), (req, res) => {
  const p = req.body?.period || period(today());
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(p);
  if (per?.state !== "reconciled" && per?.state !== "closed")
    return res.status(409).json({ code: "PERIOD_NOT_RECONCILED", state: per?.state ?? "open" });

  const buildings = db.prepare("SELECT code FROM buildings ORDER BY code").all();
  const made = [];
  for (const b of buildings) {
    const f = periodFigures(p, b.code);
    const m = figuresMethod(f);
    const id = uid("mr_");
    db.prepare(`INSERT INTO monthly_reports (id, period, building_code, figures, method)
      VALUES (?,?,?,?,?)
      ON CONFLICT(period, building_code) DO UPDATE SET figures=excluded.figures,
      method=excluded.method, generated_at=datetime('now'), state='draft'`)
      .run(id, p, b.code, JSON.stringify(f), m);
    made.push({ building: b.code, figures: f });
  }
  audit(req, { action: "report.generate", entityType: "period", entityId: p,
               after: { buildings: made.length } });
  res.status(201).json({ period: p, reports: made });
});

/** The narrative. Figures are passed in and the model is told not to
 *  recalculate: its job is to say what the numbers show, not to work them out. */
r.post("/reports/:id/narrative", require_("accounting.reports"), (req, res) => {
  const rep = db.prepare("SELECT * FROM monthly_reports WHERE id=?").get(req.params.id);
  if (!rep) return res.status(404).json({ code: "REPORT_NOT_FOUND" });
  db.prepare("UPDATE monthly_reports SET narrative=?, model=?, state='review' WHERE id=?")
    .run(req.body?.narrative ?? null, req.body?.model ?? null, rep.id);
  audit(req, { action: "report.narrative", entityType: "monthly_report", entityId: rep.id });
  res.json({ ok: true });
});

r.post("/reports/:id/approve", require_("accounting.reports"), (req, res) => {
  const rep = db.prepare("SELECT * FROM monthly_reports WHERE id=?").get(req.params.id);
  if (!rep) return res.status(404).json({ code: "REPORT_NOT_FOUND" });
  db.prepare(`UPDATE monthly_reports SET state='final', approved_by=?, approved_at=? WHERE id=?`)
    .run(req.user.id, nowISO(), rep.id);
  audit(req, { action: "report.approve", entityType: "monthly_report", entityId: rep.id });
  res.json({ ok: true });
});

/* ================= Journal ================= */

r.get("/journal", require_("accounting.view"), (req, res) => {
  const { period: p, source, building, limit = 200 } = req.query;
  let sql = "SELECT * FROM journal_entries WHERE 1=1";
  const args = [];
  if (p) { sql += " AND period = ?"; args.push(p); }
  if (source) { sql += " AND source = ?"; args.push(source); }
  if (building) { sql += " AND building_code = ?"; args.push(building); }
  sql += " ORDER BY entry_date DESC, entry_no DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  const entries = db.prepare(sql).all(...args);
  const lines = db.prepare(`SELECT jl.*, ga.name_en gl_name FROM journal_lines jl
    JOIN gl_accounts ga ON ga.code = jl.gl_code ORDER BY jl.line_no`).all();
  res.json({ entries: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) })) });
});

r.post("/journal", require_("accounting.post"), (req, res) => {
  const { entry_date, building_code, memo, lines } = req.body ?? {};
  if (!entry_date || !lines?.length) return res.status(400).json({ code: "MISSING_ENTRY_FIELDS" });
  try {
    const out = postEntry({ date: entry_date, buildingCode: building_code, source: "manual",
      memo, lines, userId: req.user.id });
    audit(req, { action: "journal.post", entityType: "journal_entry", entityId: out.id,
                 after: { memo, total: out.total } });
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, debits: e.debits, credits: e.credits,
                                        period: e.period });
  }
});

/** Reversal rather than deletion. The original stays visible and the correction
 *  is a fact of its own. */
r.post("/journal/:id/reverse", require_("accounting.post"), (req, res) => {
  try {
    const out = txn(() => {
      const orig = db.prepare("SELECT * FROM journal_entries WHERE id=?").get(req.params.id);
      if (!orig) throw Object.assign(new Error("ENTRY_NOT_FOUND"), { status: 404 });
      if (orig.state === "reversed") throw Object.assign(new Error("ALREADY_REVERSED"), { status: 409 });
      const lines = db.prepare("SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_no")
                      .all(orig.id);
      const rev = postEntry({
        date: req.body?.date || today(), buildingCode: orig.building_code,
        source: "reversal", sourceId: orig.id,
        memo: `Reversal of entry ${orig.entry_no}${req.body?.reason ? ` — ${req.body.reason}` : ""}`,
        userId: req.user.id,
        lines: lines.map((l) => ({ gl: l.gl_code, debit: l.credit, credit: l.debit,
          buildingCode: l.building_code, unit: l.unit_number, vendorId: l.vendor_id,
          contactId: l.contact_id, memo: l.memo })),
      });
      db.prepare("UPDATE journal_entries SET state='reversed', reverses_id=? WHERE id=?")
        .run(rev.id, orig.id);
      return { reversed: orig.id, reversal: rev.id, entry_no: rev.entry_no };
    })();
    audit(req, { action: "journal.reverse", entityType: "journal_entry",
                 entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ================= Dashboard ================= */

r.get("/dashboard", require_("accounting.view"), (req, res) => {
  const p = req.query.period || period(today());
  const ar = db.prepare(`SELECT SUM(amount - paid_amount) t, COUNT(*) n FROM ar_charges
    WHERE state IN ('open','partial')`).get();
  const overdue = db.prepare(`SELECT SUM(amount - paid_amount) t, COUNT(*) n FROM ar_charges
    WHERE state IN ('open','partial') AND due_date < date('now')`).get();
  const ap = db.prepare(`SELECT SUM(total - paid_amount) t, COUNT(*) n FROM ap_invoices
    WHERE state IN ('approved','partial')`).get();
  const apDue = db.prepare(`SELECT SUM(total - paid_amount) t, COUNT(*) n FROM ap_invoices
    WHERE state IN ('approved','partial') AND due_date < date('now')`).get();
  const drafts = db.prepare("SELECT COUNT(*) n FROM ap_invoices WHERE state='draft'").get().n;
  const cash = db.prepare(`SELECT ga.code, ga.name_en, ga.is_trust,
    COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0) bal
    FROM gl_accounts ga LEFT JOIN journal_lines jl ON jl.gl_code = ga.code
    WHERE ga.is_bank = 1 GROUP BY ga.code`).all();
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(p);

  res.json({
    period: p,
    period_state: per?.state ?? "open",
    ar_outstanding: cents(ar?.t || 0), ar_count: ar?.n || 0,
    ar_overdue: cents(overdue?.t || 0), ar_overdue_count: overdue?.n || 0,
    ap_outstanding: cents(ap?.t || 0), ap_count: ap?.n || 0,
    ap_overdue: cents(apDue?.t || 0), ap_overdue_count: apDue?.n || 0,
    ap_drafts: drafts,
    bank: cash.map((c) => ({ ...c, bal: cents(c.bal) })),
    figures: periodFigures(p, null),
  });
});

/* ================= Amendments ================= */
/*
   Nothing posted is edited in place and nothing is deleted. Amending
   reverses the original entry and posts a replacement, keeping both.
   The document keeps its id — anything linked to it still resolves —
   and gains a version.

   This is what lets someone fix a keying error without unpicking the
   payments and re-entering everything, while leaving a trail that
   shows what was there before and who changed it.
*/

/** Compares two snapshots and returns the fields that actually moved.
 *  Computed, not described: the audit record must not depend on anyone,
 *  or anything, remembering to say what they changed. */
function diffFields(before, after, only = null) {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (only && !only.includes(k)) continue;
    const b = before?.[k], a = after?.[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field: k, from: b ?? null, to: a ?? null });
  }
  return out;
}

function recordAmendment(req, { entityType, entityId, versionFrom, versionTo,
                                before, after, changed, reason, reversalId, replacementId }) {
  const id = uid("am_");
  db.prepare(`INSERT INTO amendments (id, entity_type, entity_id, version_from, version_to,
    before_value, after_value, changed, reason, reversal_id, replacement_id,
    amended_by, amended_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, entityType, entityId, versionFrom, versionTo,
         JSON.stringify(before), JSON.stringify(after), JSON.stringify(changed),
         reason ?? null, reversalId ?? null, replacementId ?? null,
         req.user.id, req.user.name);
  audit(req, { action: `${entityType}.amend`, entityType, entityId,
               before: { version: versionFrom }, after: { version: versionTo, changed, reason } });
  return id;
}

/** Reverses a posted entry by mirroring its lines. The original stays,
 *  marked reversed, because an auditor needs to see the correction as
 *  an event rather than find a gap where a number used to be. */
function reverseEntry(entryId, date, memo, userId) {
  const orig = db.prepare("SELECT * FROM journal_entries WHERE id=?").get(entryId);
  if (!orig) return null;
  if (orig.state === "reversed") return null;
  const lines = db.prepare("SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_no")
                  .all(entryId);
  const rev = postEntry({
    date, buildingCode: orig.building_code, source: "reversal", sourceId: orig.id,
    memo: memo ?? `Reversal of entry ${orig.entry_no}`, userId,
    lines: lines.map((l) => ({ gl: l.gl_code, debit: l.credit, credit: l.debit,
      buildingCode: l.building_code, unit: l.unit_number, vendorId: l.vendor_id,
      contactId: l.contact_id, memo: l.memo })),
  });
  db.prepare("UPDATE journal_entries SET state='reversed', reverses_id=? WHERE id=?")
    .run(rev.id, orig.id);
  return rev;
}

/* ---------- Amend a vendor invoice ---------- */

r.patch("/ap/invoices/:id", require_("accounting.ap"), (req, res) => {
  const inv = db.prepare("SELECT * FROM ap_invoices WHERE id=?").get(req.params.id);
  if (!inv) return res.status(404).json({ code: "INVOICE_NOT_FOUND" });

  const { reason, lines, gst, invoice_date, due_date, description,
          building_code, unit_number, invoice_no } = req.body ?? {};

  // A draft has never been posted, so it edits freely.
  if (inv.state === "draft") {
    const beforeLines = db.prepare("SELECT * FROM ap_invoice_lines WHERE invoice_id=?").all(inv.id);
    const before = { ...inv, lines: beforeLines };
    let subtotal = inv.subtotal;
    db.transaction(() => {
      if (lines) {
        db.prepare("DELETE FROM ap_invoice_lines WHERE invoice_id=?").run(inv.id);
        const insL = db.prepare(`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
          description, amount, building_code, unit_number) VALUES (?,?,?,?,?,?,?,?)`);
        lines.forEach((l, i) => insL.run(uid("al_"), inv.id, i + 1, l.gl_code,
          l.description ?? null, cents(l.amount), l.building_code ?? null, l.unit_number ?? null));
        subtotal = cents(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
      }
      const g = gst == null ? inv.gst : cents(gst);
      db.prepare(`UPDATE ap_invoices SET invoice_no=COALESCE(?,invoice_no),
        invoice_date=COALESCE(?,invoice_date), due_date=COALESCE(?,due_date),
        description=COALESCE(?,description), building_code=COALESCE(?,building_code),
        unit_number=COALESCE(?,unit_number), subtotal=?, gst=?, total=? WHERE id=?`)
        .run(invoice_no ?? null, invoice_date ?? null, due_date ?? null, description ?? null,
             building_code ?? null, unit_number ?? null, subtotal, g, cents(subtotal + g), inv.id);
    })();
    const after = db.prepare("SELECT * FROM ap_invoices WHERE id=?").get(inv.id);
    audit(req, { action: "ap.edit_draft", entityType: "ap_invoice", entityId: inv.id,
                 before, after });
    return res.json({ ok: true, posted: false, version: inv.version });
  }

  if (inv.state === "void") return res.status(409).json({ code: "INVOICE_VOID" });
  if (!reason?.trim()) return res.status(400).json({ code: "AMENDMENT_REASON_REQUIRED" });

  try {
    const out = txn(() => {
      const beforeLines = db.prepare("SELECT * FROM ap_invoice_lines WHERE invoice_id=? ORDER BY line_no")
                            .all(inv.id);
      const before = { invoice_no: inv.invoice_no, invoice_date: inv.invoice_date,
        due_date: inv.due_date, subtotal: inv.subtotal, gst: inv.gst, total: inv.total,
        description: inv.description, building_code: inv.building_code,
        lines: beforeLines.map((l) => ({ gl_code: l.gl_code, description: l.description,
          amount: l.amount, unit_number: l.unit_number })) };

      const newLines = lines ?? before.lines;
      const subtotal = cents(newLines.reduce((s, l) => s + Number(l.amount || 0), 0));
      const g = gst == null ? inv.gst : cents(gst);
      const total = cents(subtotal + g);

      // An amendment cannot take the total below what has already been paid.
      // Refunding an overpayment is a separate decision, not a side effect of
      // correcting a typo.
      if (total < cents(inv.paid_amount))
        throw Object.assign(new Error("BELOW_PAID_AMOUNT"),
          { status: 409, paid: cents(inv.paid_amount), proposed: total });

      const amendDate = req.body?.amend_date || today();
      const reversal = reverseEntry(inv.entry_id, amendDate,
        `Reversal — amending ${inv.invoice_no}`, req.user.id);

      const jl = newLines.map((l) => ({ gl: l.gl_code, debit: cents(l.amount),
        buildingCode: l.building_code ?? building_code ?? inv.building_code,
        unit: l.unit_number ?? unit_number ?? inv.unit_number,
        vendorId: inv.vendor_id, memo: l.description }));
      if (g > 0) jl.push({ gl: "1210", debit: g, vendorId: inv.vendor_id, memo: "GST input tax credit" });
      jl.push({ gl: "2010", credit: total, vendorId: inv.vendor_id,
        buildingCode: building_code ?? inv.building_code,
        memo: `${invoice_no ?? inv.invoice_no} (v${inv.version + 1})` });

      const replacement = postEntry({ date: amendDate,
        buildingCode: building_code ?? inv.building_code, source: "ap_invoice",
        sourceId: inv.id, memo: `AP ${invoice_no ?? inv.invoice_no} — amended: ${reason.trim()}`,
        lines: jl, userId: req.user.id });

      db.prepare("DELETE FROM ap_invoice_lines WHERE invoice_id=?").run(inv.id);
      const insL = db.prepare(`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
        description, amount, building_code, unit_number) VALUES (?,?,?,?,?,?,?,?)`);
      newLines.forEach((l, i) => insL.run(uid("al_"), inv.id, i + 1, l.gl_code,
        l.description ?? null, cents(l.amount), l.building_code ?? null, l.unit_number ?? null));

      const paid = cents(inv.paid_amount);
      db.prepare(`UPDATE ap_invoices SET invoice_no=COALESCE(?,invoice_no),
        invoice_date=COALESCE(?,invoice_date), due_date=COALESCE(?,due_date),
        description=COALESCE(?,description), building_code=COALESCE(?,building_code),
        unit_number=COALESCE(?,unit_number), subtotal=?, gst=?, total=?,
        entry_id=?, version=version+1,
        state=CASE WHEN ? >= ? THEN 'paid' WHEN ? > 0 THEN 'partial' ELSE 'approved' END
        WHERE id=?`)
        .run(invoice_no ?? null, invoice_date ?? null, due_date ?? null, description ?? null,
             building_code ?? null, unit_number ?? null, subtotal, g, total,
             replacement.id, paid, total, paid, inv.id);

      const after = { invoice_no: invoice_no ?? inv.invoice_no,
        invoice_date: invoice_date ?? inv.invoice_date, due_date: due_date ?? inv.due_date,
        subtotal, gst: g, total, description: description ?? inv.description,
        building_code: building_code ?? inv.building_code,
        lines: newLines.map((l) => ({ gl_code: l.gl_code, description: l.description,
          amount: cents(l.amount), unit_number: l.unit_number })) };

      const changed = diffFields(before, after);
      const amendmentId = recordAmendment(req, { entityType: "ap_invoice", entityId: inv.id,
        versionFrom: inv.version, versionTo: inv.version + 1, before, after, changed,
        reason: reason.trim(), reversalId: reversal?.id, replacementId: replacement.id });

      return { amendment_id: amendmentId, version: inv.version + 1, total,
               reversal_entry: reversal?.entry_no ?? null, replacement_entry: replacement.entry_no,
               changed };
    })();
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, paid: e.paid, proposed: e.proposed,
                                        period: e.period });
  }
});

/* ---------- Amend a receipt ---------- */

r.patch("/ar/receipts/:id", require_("accounting.ar"), (req, res) => {
  const rec = db.prepare("SELECT * FROM ar_receipts WHERE id=?").get(req.params.id);
  if (!rec) return res.status(404).json({ code: "RECEIPT_NOT_FOUND" });
  const { reason, amount, received_date, method, reference, unit_number, applications } = req.body ?? {};
  if (!reason?.trim()) return res.status(400).json({ code: "AMENDMENT_REASON_REQUIRED" });

  try {
    const out = txn(() => {
      const oldApps = db.prepare("SELECT * FROM ar_applications WHERE receipt_id=?").all(rec.id);
      const before = { amount: rec.amount, received_date: rec.received_date, method: rec.method,
        reference: rec.reference, unit_number: rec.unit_number,
        applications: oldApps.map((a) => ({ charge_id: a.charge_id, amount: a.amount })) };

      // Applications are unwound first, or the charges keep credit from a
      // receipt that no longer says what it used to.
      for (const a of oldApps) {
        const ch = db.prepare("SELECT * FROM ar_charges WHERE id=?").get(a.charge_id);
        if (!ch) continue;
        const paid = cents(ch.paid_amount - a.amount);
        db.prepare("UPDATE ar_charges SET paid_amount=?, state=? WHERE id=?")
          .run(paid, paid <= 0 ? "open" : paid >= cents(ch.amount) ? "paid" : "partial", ch.id);
      }
      db.prepare("DELETE FROM ar_applications WHERE receipt_id=?").run(rec.id);

      const amendDate = req.body?.amend_date || today();
      const reversal = reverseEntry(rec.entry_id, amendDate,
        `Reversal — amending receipt ${rec.receipt_no}`, req.user.id);

      const newAmount = amount == null ? rec.amount : cents(amount);
      const newUnit = unit_number ?? rec.unit_number;
      const newApps = applications ?? before.applications;
      const applied = cents(newApps.reduce((s, a) => s + Number(a.amount || 0), 0));
      if (applied > newAmount)
        throw Object.assign(new Error("APPLIED_EXCEEDS_RECEIPT"),
          { status: 400, applied, amount: newAmount });

      const u = newUnit
        ? db.prepare("SELECT building_code FROM units WHERE unit_number=?").get(newUnit) : null;
      const jl = [{ gl: rec.deposit_to, debit: newAmount, unit: newUnit,
                    buildingCode: u?.building_code }];
      if (applied > 0) jl.push({ gl: "1100", credit: applied, unit: newUnit,
                                 buildingCode: u?.building_code });
      const unapplied = cents(newAmount - applied);
      if (unapplied > 0) jl.push({ gl: "2200", credit: unapplied, unit: newUnit,
                                   memo: "Prepaid rent" });

      const replacement = postEntry({ date: received_date ?? rec.received_date,
        buildingCode: u?.building_code, source: "ar_receipt", sourceId: rec.id,
        memo: `Receipt ${rec.receipt_no} — amended: ${reason.trim()}`,
        lines: jl, userId: req.user.id });

      const insA = db.prepare(`INSERT INTO ar_applications (id, receipt_id, charge_id, amount)
                               VALUES (?,?,?,?)`);
      for (const a of newApps) {
        const ch = db.prepare("SELECT * FROM ar_charges WHERE id=?").get(a.charge_id);
        if (!ch) continue;
        insA.run(uid("ara_"), rec.id, a.charge_id, cents(a.amount));
        const paid = cents(ch.paid_amount + Number(a.amount));
        db.prepare("UPDATE ar_charges SET paid_amount=?, state=? WHERE id=?")
          .run(paid, paid >= cents(ch.amount) ? "paid" : "partial", ch.id);
      }

      db.prepare(`UPDATE ar_receipts SET amount=?, received_date=COALESCE(?,received_date),
        method=COALESCE(?,method), reference=COALESCE(?,reference),
        unit_number=COALESCE(?,unit_number), entry_id=?, version=version+1 WHERE id=?`)
        .run(newAmount, received_date ?? null, method ?? null, reference ?? null,
             unit_number ?? null, replacement.id, rec.id);

      const after = { amount: newAmount, received_date: received_date ?? rec.received_date,
        method: method ?? rec.method, reference: reference ?? rec.reference,
        unit_number: newUnit, applications: newApps };
      const changed = diffFields(before, after);
      const amendmentId = recordAmendment(req, { entityType: "ar_receipt", entityId: rec.id,
        versionFrom: rec.version, versionTo: rec.version + 1, before, after, changed,
        reason: reason.trim(), reversalId: reversal?.id, replacementId: replacement.id });

      return { amendment_id: amendmentId, version: rec.version + 1, amount: newAmount, changed };
    })();
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, applied: e.applied, amount: e.amount });
  }
});

/* ---------- Amend a rent charge ---------- */

r.patch("/ar/charges/:id", require_("accounting.ar"), (req, res) => {
  const ch = db.prepare("SELECT * FROM ar_charges WHERE id=?").get(req.params.id);
  if (!ch) return res.status(404).json({ code: "CHARGE_NOT_FOUND" });
  const { reason, amount, due_date, description, gl_code } = req.body ?? {};
  if (!reason?.trim()) return res.status(400).json({ code: "AMENDMENT_REASON_REQUIRED" });

  try {
    const out = txn(() => {
      const before = { amount: ch.amount, due_date: ch.due_date, gl_code: ch.gl_code,
                       description: ch.description };
      const newAmount = amount == null ? ch.amount : cents(amount);
      if (newAmount < cents(ch.paid_amount))
        throw Object.assign(new Error("BELOW_PAID_AMOUNT"),
          { status: 409, paid: cents(ch.paid_amount), proposed: newAmount });

      const amendDate = req.body?.amend_date || today();
      const reversal = reverseEntry(ch.entry_id, amendDate,
        `Reversal — amending ${ch.kind} ${ch.unit_number} ${ch.period}`, req.user.id);

      const newGl = gl_code ?? ch.gl_code;
      const replacement = postEntry({ date: ch.charge_date, buildingCode: ch.building_code,
        source: "rent_run", sourceId: ch.id,
        memo: `${ch.kind} ${ch.unit_number} ${ch.period} — amended: ${reason.trim()}`,
        userId: req.user.id,
        lines: [{ gl: "1100", debit: newAmount, unit: ch.unit_number,
                  contactId: ch.contact_id, buildingCode: ch.building_code },
                { gl: newGl, credit: newAmount, unit: ch.unit_number,
                  buildingCode: ch.building_code }] });

      const paid = cents(ch.paid_amount);
      db.prepare(`UPDATE ar_charges SET amount=?, due_date=COALESCE(?,due_date),
        description=COALESCE(?,description), gl_code=?, entry_id=?, version=version+1,
        state=CASE WHEN ? >= ? THEN 'paid' WHEN ? > 0 THEN 'partial' ELSE 'open' END
        WHERE id=?`)
        .run(newAmount, due_date ?? null, description ?? null, newGl, replacement.id,
             paid, newAmount, paid, ch.id);

      const after = { amount: newAmount, due_date: due_date ?? ch.due_date, gl_code: newGl,
                      description: description ?? ch.description };
      const changed = diffFields(before, after);
      const amendmentId = recordAmendment(req, { entityType: "ar_charge", entityId: ch.id,
        versionFrom: ch.version, versionTo: ch.version + 1, before, after, changed,
        reason: reason.trim(), reversalId: reversal?.id, replacementId: replacement.id });

      return { amendment_id: amendmentId, version: ch.version + 1, amount: newAmount, changed };
    })();
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, paid: e.paid, proposed: e.proposed });
  }
});

/* ---------- Void, which is an amendment to nothing ---------- */

r.post("/ap/invoices/:id/void", require_("accounting.ap"), (req, res) => {
  const inv = db.prepare("SELECT * FROM ap_invoices WHERE id=?").get(req.params.id);
  if (!inv) return res.status(404).json({ code: "INVOICE_NOT_FOUND" });
  if (cents(inv.paid_amount) > 0)
    return res.status(409).json({ code: "CANNOT_VOID_PAID", paid: cents(inv.paid_amount) });
  const reason = req.body?.reason;
  if (!reason?.trim()) return res.status(400).json({ code: "AMENDMENT_REASON_REQUIRED" });

  try {
    const out = txn(() => {
      const reversal = inv.entry_id
        ? reverseEntry(inv.entry_id, req.body?.amend_date || today(),
            `Void ${inv.invoice_no} — ${reason.trim()}`, req.user.id)
        : null;
      db.prepare("UPDATE ap_invoices SET state='void', version=version+1 WHERE id=?").run(inv.id);
      const amendmentId = recordAmendment(req, { entityType: "ap_invoice", entityId: inv.id,
        versionFrom: inv.version, versionTo: inv.version + 1,
        before: { state: inv.state, total: inv.total }, after: { state: "void", total: 0 },
        changed: [{ field: "state", from: inv.state, to: "void" }],
        reason: reason.trim(), reversalId: reversal?.id });
      return { amendment_id: amendmentId, reversal_entry: reversal?.entry_no ?? null };
    })();
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ---------- History ---------- */

r.get("/amendments", require_("accounting.view"), (req, res) => {
  const { entity_type, entity_id, limit = 100 } = req.query;
  let sql = "SELECT * FROM amendments WHERE 1=1";
  const args = [];
  if (entity_type) { sql += " AND entity_type = ?"; args.push(entity_type); }
  if (entity_id) { sql += " AND entity_id = ?"; args.push(entity_id); }
  sql += " ORDER BY amended_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 100, 500));
  res.json({ amendments: db.prepare(sql).all(...args).map((a) => ({
    ...a, before_value: JSON.parse(a.before_value), after_value: JSON.parse(a.after_value),
    changed: JSON.parse(a.changed) })) });
});

/** The AI narrative sits beside the amendment, never in place of it. The
 *  computed diff is the record; this makes it readable a month later. */
r.post("/amendments/:id/narrative", require_("accounting.post"), (req, res) => {
  const a = db.prepare("SELECT * FROM amendments WHERE id=?").get(req.params.id);
  if (!a) return res.status(404).json({ code: "AMENDMENT_NOT_FOUND" });
  db.prepare("UPDATE amendments SET narrative=?, narrative_model=? WHERE id=?")
    .run(req.body?.narrative ?? null, req.body?.model ?? null, a.id);
  res.json({ ok: true });
});

/* ================= Deposit interest rate ================= */
/*
   Alberta publishes this annually. A wrong rate means every refund is
   wrong and nobody finds out until a tenant leaves, so the AI researches
   and proposes with its source; a person confirms before it can be used.
*/

r.get("/interest-rates", require_("accounting.view"), (req, res) => {
  res.json({
    rates: db.prepare("SELECT * FROM deposit_interest_rates ORDER BY year DESC").all(),
    proposals: db.prepare(`SELECT * FROM interest_rate_proposals
                           ORDER BY year DESC, created_at DESC`).all(),
  });
});

r.post("/interest-rates/propose", require_("accounting.post"), (req, res) => {
  const { year, rate, source_text, source_url, confidence, reasoning, model } = req.body ?? {};
  if (!year || rate == null) return res.status(400).json({ code: "MISSING_RATE_FIELDS" });
  const id = uid("irp_");
  db.prepare(`INSERT INTO interest_rate_proposals (id, year, rate, source_text, source_url,
    confidence, reasoning, model) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, Number(year), Number(rate), source_text ?? null, source_url ?? null,
         confidence ?? "unverified", reasoning ?? null, model ?? null);
  audit(req, { action: "interest.propose", entityType: "interest_rate", entityId: String(year),
               after: { rate, confidence, source_url } });
  notify("accounting", "accounting", "INTEREST_RATE_PROPOSED",
         { year, rate, confidence: confidence ?? "unverified" }, "/accounting/settings");
  res.status(201).json({ id });
});

/** Confirming is a person taking responsibility for the number. Until then
 *  the accrual has nothing to run on. */
r.post("/interest-rates/:id/confirm", require_("accounting.close"), (req, res) => {
  const p = db.prepare("SELECT * FROM interest_rate_proposals WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "PROPOSAL_NOT_FOUND" });
  const rate = req.body?.rate == null ? p.rate : Number(req.body.rate);

  db.transaction(() => {
    db.prepare(`UPDATE interest_rate_proposals SET state='confirmed', confirmed_by=?,
      confirmed_at=?, rate=? WHERE id=?`).run(req.user.id, nowISO(), rate, p.id);
    db.prepare(`INSERT INTO deposit_interest_rates (year, rate, source, set_by)
      VALUES (?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET rate=excluded.rate, source=excluded.source,
      set_by=excluded.set_by, set_at=datetime('now')`)
      .run(p.year, rate, p.source_url || p.source_text || "confirmed by accounting", req.user.id);
  })();

  audit(req, { action: "interest.confirm", entityType: "interest_rate", entityId: String(p.year),
               before: { proposed: p.rate }, after: { rate, confirmed_by: req.user.name } });
  res.json({ ok: true, year: p.year, rate });
});

r.post("/interest-rates/:id/reject", require_("accounting.close"), (req, res) => {
  db.prepare(`UPDATE interest_rate_proposals SET state='rejected', rejected_reason=?
              WHERE id=?`).run(req.body?.reason ?? null, req.params.id);
  audit(req, { action: "interest.reject", entityType: "interest_rate", entityId: req.params.id,
               after: { reason: req.body?.reason } });
  res.json({ ok: true });
});

/* ================= Change log ================= */

r.get("/changelog", require_("accounting.view"), (req, res) => {
  const { limit = 200, entity_type } = req.query;
  const args = [];
  let sql = `SELECT a.*, n.narrative, n.model FROM audit_log a
             LEFT JOIN audit_narratives n ON n.audit_id = a.id
             WHERE (a.action LIKE 'ap.%' OR a.action LIKE 'ar.%' OR a.action LIKE 'journal.%'
                 OR a.action LIKE 'deposit.%' OR a.action LIKE 'bank.%'
                 OR a.action LIKE 'period.%' OR a.action LIKE 'interest.%'
                 OR a.action LIKE 'coa.%' OR a.action LIKE 'vendor.%'
                 OR a.action LIKE 'schedule.%' OR a.action LIKE 'report.%')`;
  if (entity_type) { sql += " AND a.entity_type = ?"; args.push(entity_type); }
  sql += " ORDER BY a.id DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  res.json({ entries: db.prepare(sql).all(...args).map((e) => ({
    ...e,
    before_value: e.before_value ? JSON.parse(e.before_value) : null,
    after_value: e.after_value ? JSON.parse(e.after_value) : null,
  })) });
});

r.post("/changelog/:auditId/narrative", require_("accounting.post"), (req, res) => {
  const text = req.body?.narrative;
  if (!text?.trim()) return res.status(400).json({ code: "NARRATIVE_REQUIRED" });
  db.prepare(`INSERT INTO audit_narratives (audit_id, narrative, model) VALUES (?,?,?)
              ON CONFLICT(audit_id) DO UPDATE SET narrative=excluded.narrative,
              model=excluded.model`)
    .run(Number(req.params.auditId), text.trim(), req.body?.model ?? null);
  res.json({ ok: true });
});

export default r;
