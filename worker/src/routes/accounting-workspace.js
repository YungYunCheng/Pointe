import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";

const r = new Hono();
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const CAPTURE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const REVIEW_STATES = new Set(["review", "matched", "posted", "excluded"]);

const cents = (value) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100 : null;
};
const json = (value, fallback = {}) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeFilename = (value, fallback = "document") =>
  (String(value ?? "").replace(/[\r\n"\\/]/g, "_").trim() || fallback).slice(0, 180);
const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function putReview(sql, sourceType, sourceId, patch, user = null) {
  const [row] = await sql`
    INSERT INTO accounting_transaction_reviews (source_type, source_id, status,
      matched_type, matched_id, suggested_type, suggested_id, suggested_gl,
      confidence, rule_id, note, reviewed_by, reviewed_at, updated_at)
    VALUES (${sourceType}, ${sourceId}, ${patch.status ?? "review"},
      ${patch.matched_type ?? null}, ${patch.matched_id ?? null},
      ${patch.suggested_type ?? null}, ${patch.suggested_id ?? null},
      ${patch.suggested_gl ?? null}, ${patch.confidence ?? null},
      ${patch.rule_id ?? null}, ${patch.note ?? null}, ${user?.id ?? null},
      ${user ? new Date().toISOString() : null}, now())
    ON CONFLICT (source_type, source_id) DO UPDATE SET
      status = EXCLUDED.status,
      matched_type = EXCLUDED.matched_type,
      matched_id = EXCLUDED.matched_id,
      suggested_type = EXCLUDED.suggested_type,
      suggested_id = EXCLUDED.suggested_id,
      suggested_gl = EXCLUDED.suggested_gl,
      confidence = EXCLUDED.confidence,
      rule_id = EXCLUDED.rule_id,
      note = EXCLUDED.note,
      reviewed_by = COALESCE(EXCLUDED.reviewed_by, accounting_transaction_reviews.reviewed_by),
      reviewed_at = COALESCE(EXCLUDED.reviewed_at, accounting_transaction_reviews.reviewed_at),
      updated_at = now()
    RETURNING *`;
  return row;
}

async function postJournal(sql, user, payload) {
  const date = String(payload.date ?? "");
  const period = date.slice(0, 7);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || lines.length < 2)
    throw Object.assign(new Error("JOURNAL_FIELDS_REQUIRED"), { status: 400, code: "JOURNAL_FIELDS_REQUIRED" });
  const debit = cents(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const credit = cents(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  if (!debit || debit !== credit)
    throw Object.assign(new Error("JOURNAL_MUST_BALANCE"), { status: 400, code: "JOURNAL_MUST_BALANCE" });
  if (!lines.every((line) => line.gl_code && ((Number(line.debit) > 0) !== (Number(line.credit) > 0))))
    throw Object.assign(new Error("VALID_JOURNAL_LINES_REQUIRED"), { status: 400, code: "VALID_JOURNAL_LINES_REQUIRED" });

  return sql.begin(async (tx) => {
    const [periodRow] = await tx`SELECT state FROM accounting_periods WHERE period = ${period}`;
    if (periodRow?.state === "closed")
      throw Object.assign(new Error("ACCOUNTING_PERIOD_CLOSED"), { status: 409, code: "ACCOUNTING_PERIOD_CLOSED" });
    const accountCodes = [...new Set(lines.map((line) => line.gl_code))];
    const accounts = await tx`SELECT code FROM gl_accounts
      WHERE code = ANY(${accountCodes}) AND is_active AND is_postable`;
    if (accounts.length !== accountCodes.length)
      throw Object.assign(new Error("ACTIVE_POSTABLE_ACCOUNTS_REQUIRED"), { status: 400, code: "ACTIVE_POSTABLE_ACCOUNTS_REQUIRED" });
    const id = uid("je_");
    const [{ next_no }] = await tx`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_no FROM journal_entries`;
    const [entry] = await tx`
      INSERT INTO journal_entries (id, entry_no, entry_date, period, building_code,
        source, source_id, memo, state, created_by)
      VALUES (${id}, ${next_no}, ${date}, ${period}, ${payload.building_code || null},
        ${payload.source || "manual"}, ${payload.source_id || null},
        ${payload.memo || null}, 'posted', ${user.id}) RETURNING *`;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      await tx`
        INSERT INTO journal_lines (id, entry_id, line_no, gl_code, debit, credit,
          building_code, unit_number, vendor_id, memo)
        VALUES (${uid("jl_")}, ${id}, ${index + 1}, ${line.gl_code},
          ${cents(line.debit || 0)}, ${cents(line.credit || 0)},
          ${line.building_code || payload.building_code || null}, ${line.unit_number || null},
          ${line.vendor_id || null}, ${line.memo || null})`;
    }
    return entry;
  });
}

function transactionStatus(source, row) {
  if (row.review_status) return row.review_status;
  if (source === "bank_transaction") return row.matched_id ? "matched" : "review";
  if (source === "ap_invoice") return row.state === "draft" ? "review" : "posted";
  return "posted";
}

const STATE_DATASETS = new Set([
  "acct:vendors", "acct:invoices", "acct:schedules", "acct:charges",
  "acct:receipts", "acct:entries", "acct:periods", "acct:statements",
  "acct:reports", "acct:amendments", "acct:rates", "acct:proposals",
  "acct:formulas", "acct:calculations", "acct:payroll", "acct:distributions",
  "acct:gst", "acct:assets", "acct:depreciation", "acct:arrears",
]);

r.get("/accounting/state", require_("accounting.view"), async (c) => {
  const rows = await c.get("db")`SELECT dataset, value, updated_at FROM accounting_workspace_state`;
  return c.json({ state: Object.fromEntries(rows.map((row) => [row.dataset, json(row.value, [])])) });
});

r.patch("/accounting/state", require_("accounting.view"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!STATE_DATASETS.has(body.dataset) || !Array.isArray(body.value))
    return c.json({ code: "INVALID_ACCOUNTING_DATASET" }, 400);
  const user = c.get("user");
  const pmWritable = new Set(["acct:reports", "acct:arrears"]);
  if (!['accounting', 'admin'].includes(user.role) &&
      !(user.role === "property_manager" && pmWritable.has(body.dataset)))
    return c.json({ code: "ACCOUNTING_WRITE_REQUIRED" }, 403);
  const [row] = await c.get("db")`
    INSERT INTO accounting_workspace_state (dataset, value, updated_by, updated_at)
    VALUES (${body.dataset}, ${JSON.stringify(body.value)}, ${user.id}, now())
    ON CONFLICT (dataset) DO UPDATE SET value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING dataset, updated_at`;
  await audit(c, { action: "accounting.workspace_state.update", entityType: "accounting_workspace_state",
    entityId: body.dataset, after: { rows: body.value.length } });
  return c.json({ saved: true, ...row });
});

/* ---------- Unified transaction centre ---------- */

r.get("/accounting/workspace", require_("accounting.view"), async (c) => {
  const sql = c.get("db");
  const bank = await sql`
    SELECT bt.*, bs.gl_code AS bank_gl, bs.period, bs.filename AS statement_filename,
      rv.status AS review_status, rv.matched_type AS review_matched_type,
      rv.matched_id AS review_matched_id, rv.suggested_type, rv.suggested_id,
      rv.suggested_gl, rv.confidence, rv.rule_id, rv.note AS review_note
    FROM bank_transactions bt
    JOIN bank_statements bs ON bs.id = bt.statement_id
    LEFT JOIN accounting_transaction_reviews rv
      ON rv.source_type = 'bank_transaction' AND rv.source_id = bt.id
    ORDER BY bt.txn_date DESC, bt.id DESC LIMIT 500`;
  const invoices = await sql`
    SELECT i.*, v.name AS vendor_name, rv.status AS review_status, rv.note AS review_note
    FROM ap_invoices i JOIN vendors v ON v.id = i.vendor_id
    LEFT JOIN accounting_transaction_reviews rv
      ON rv.source_type = 'ap_invoice' AND rv.source_id = i.id
    ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 250`;
  const receipts = await sql`
    SELECT a.*, rv.status AS review_status, rv.note AS review_note
    FROM ar_receipts a LEFT JOIN accounting_transaction_reviews rv
      ON rv.source_type = 'ar_receipt' AND rv.source_id = a.id
    ORDER BY a.received_date DESC, a.created_at DESC LIMIT 250`;
  const journals = await sql`
    SELECT j.*, rv.status AS review_status, rv.note AS review_note,
      COALESCE((SELECT SUM(l.debit) FROM journal_lines l WHERE l.entry_id = j.id), 0) AS amount
    FROM journal_entries j LEFT JOIN accounting_transaction_reviews rv
      ON rv.source_type = 'journal_entry' AND rv.source_id = j.id
    ORDER BY j.entry_date DESC, j.created_at DESC LIMIT 250`;

  const transactions = [
    ...bank.map((row) => ({ ...row, source_type: "bank_transaction", source_id: row.id,
      date: row.txn_date, name: row.description || "Bank transaction",
      amount: cents(Number(row.credit) - Number(row.debit)), direction: Number(row.credit) > 0 ? "in" : "out",
      status: transactionStatus("bank_transaction", row) })),
    ...invoices.map((row) => ({ ...row, source_type: "ap_invoice", source_id: row.id,
      date: row.invoice_date, name: row.vendor_name, description: row.description || `Invoice ${row.invoice_no}`,
      amount: -Number(row.total), direction: "out", status: transactionStatus("ap_invoice", row) })),
    ...receipts.map((row) => ({ ...row, source_type: "ar_receipt", source_id: row.id,
      date: row.received_date, name: row.unit_number ? `Tenant · ${row.unit_number}` : "Tenant receipt",
      description: row.note || row.reference || row.method, amount: Number(row.amount), direction: "in",
      status: transactionStatus("ar_receipt", row) })),
    ...journals.map((row) => ({ ...row, source_type: "journal_entry", source_id: row.id,
      date: row.entry_date, name: row.memo || `Journal ${row.entry_no || ""}`,
      description: row.source, amount: Number(row.amount), direction: "journal",
      status: transactionStatus("journal_entry", row) })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.source_id).localeCompare(String(a.source_id)));

  const counts = { review: 0, matched: 0, posted: 0, excluded: 0 };
  for (const transaction of transactions) counts[transaction.status] = (counts[transaction.status] || 0) + 1;
  return c.json({ transactions, counts,
    accounts: await sql`SELECT code, name_en AS name, type, is_bank, is_trust
      FROM gl_accounts WHERE is_active AND is_postable ORDER BY code`,
    vendors: await sql`SELECT id, name, default_gl, payment_terms FROM vendors WHERE is_active ORDER BY name`,
  });
});

r.post("/accounting/bank-transactions/:id/review", require_("accounting.post"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = body.action;
  if (!["exclude", "restore", "match", "post"].includes(action))
    return c.json({ code: "INVALID_REVIEW_ACTION" }, 400);
  const sql = c.get("db");
  const user = c.get("user");
  const [transaction] = await sql`
    SELECT bt.*, bs.gl_code AS bank_gl FROM bank_transactions bt
    JOIN bank_statements bs ON bs.id = bt.statement_id WHERE bt.id = ${c.req.param("id")}`;
  if (!transaction) return c.json({ code: "NOT_FOUND" }, 404);

  let patch = { status: "review", note: body.note || null };
  let entry = null;
  if (action === "exclude") patch.status = "excluded";
  if (action === "match") {
    if (!body.matched_type || !body.matched_id) return c.json({ code: "MATCH_REQUIRED" }, 400);
    patch = { status: "matched", matched_type: body.matched_type, matched_id: body.matched_id,
      note: body.note || null };
  }
  if (action === "post") {
    const currentType = body.matched_type || transaction.matched_type;
    const currentId = body.matched_id || transaction.matched_id;
    if (currentType && currentId) {
      patch = { status: "posted", matched_type: currentType, matched_id: currentId,
        note: body.note || null };
    } else {
      if (!body.gl_code) return c.json({ code: "GL_ACCOUNT_REQUIRED" }, 400);
      const amount = cents(Math.max(Number(transaction.debit), Number(transaction.credit)));
      const moneyIn = Number(transaction.credit) > 0;
      entry = await postJournal(sql, user, {
        date: transaction.txn_date, source: "bank_transaction", source_id: transaction.id,
        memo: transaction.description || "Bank transaction", lines: moneyIn ? [
          { gl_code: transaction.bank_gl, debit: amount, credit: 0 },
          { gl_code: body.gl_code, debit: 0, credit: amount },
        ] : [
          { gl_code: body.gl_code, debit: amount, credit: 0 },
          { gl_code: transaction.bank_gl, debit: 0, credit: amount },
        ],
      });
      patch = { status: "posted", matched_type: "journal_entry", matched_id: entry.id,
        note: body.note || null };
    }
  }
  const review = await putReview(sql, "bank_transaction", transaction.id, patch, user);
  await sql`UPDATE bank_transactions SET matched_type = ${review.matched_type},
    matched_id = ${review.matched_id}, matched_by = ${user.id}, matched_at = now()
    WHERE id = ${transaction.id}`;
  await audit(c, { action: `accounting.transaction.${action}`, entityType: "bank_transaction",
    entityId: transaction.id, after: review });
  return c.json({ review, entry });
});

/* ---------- Bank rules and suggestion engine ---------- */

r.get("/accounting/bank-rules", require_("accounting.view"), async (c) => {
  const rules = await c.get("db")`SELECT * FROM accounting_bank_rules ORDER BY priority, created_at`;
  for (const rule of rules) {
    rule.conditions = json(rule.conditions);
    rule.actions = json(rule.actions);
  }
  return c.json({ rules });
});

r.post("/accounting/bank-rules", require_("accounting.bank"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!String(body.name ?? "").trim()) return c.json({ code: "RULE_NAME_REQUIRED" }, 400);
  const user = c.get("user");
  const [rule] = await c.get("db")`
    INSERT INTO accounting_bank_rules (id, name, priority, conditions, actions,
      auto_confirm, is_active, created_by, updated_by)
    VALUES (${uid("abr_")}, ${String(body.name).trim()}, ${Number(body.priority) || 100},
      ${JSON.stringify(body.conditions || {})}, ${JSON.stringify(body.actions || {})},
      ${!!body.auto_confirm}, TRUE, ${user.id}, ${user.id}) RETURNING *`;
  await audit(c, { action: "accounting.bank_rule.create", entityType: "accounting_bank_rule",
    entityId: rule.id, after: rule });
  return c.json({ rule }, 201);
});

r.patch("/accounting/bank-rules/:id", require_("accounting.bank"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const user = c.get("user");
  const [before] = await sql`SELECT * FROM accounting_bank_rules WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const [rule] = await sql`
    UPDATE accounting_bank_rules SET
      name = ${body.name == null ? before.name : String(body.name).trim()},
      priority = ${body.priority == null ? before.priority : Number(body.priority)},
      conditions = ${body.conditions == null ? JSON.stringify(json(before.conditions)) : JSON.stringify(body.conditions)},
      actions = ${body.actions == null ? JSON.stringify(json(before.actions)) : JSON.stringify(body.actions)},
      auto_confirm = ${body.auto_confirm == null ? before.auto_confirm : !!body.auto_confirm},
      is_active = ${body.is_active == null ? before.is_active : !!body.is_active},
      updated_by = ${user.id}, updated_at = now()
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "accounting.bank_rule.update", entityType: "accounting_bank_rule",
    entityId: rule.id, before, after: rule });
  return c.json({ rule });
});

r.delete("/accounting/bank-rules/:id", require_("accounting.bank"), async (c) => {
  const sql = c.get("db");
  const [rule] = await sql`DELETE FROM accounting_bank_rules WHERE id = ${c.req.param("id")} RETURNING *`;
  if (!rule) return c.json({ code: "NOT_FOUND" }, 404);
  await audit(c, { action: "accounting.bank_rule.delete", entityType: "accounting_bank_rule",
    entityId: rule.id, before: rule });
  return c.json({ ok: true });
});

function ruleMatches(rule, transaction) {
  const conditions = json(rule.conditions);
  const description = String(transaction.description ?? "").toLowerCase();
  const amount = Math.max(Number(transaction.debit), Number(transaction.credit));
  if (conditions.contains && !description.includes(String(conditions.contains).toLowerCase())) return false;
  if (conditions.direction === "in" && Number(transaction.credit) <= 0) return false;
  if (conditions.direction === "out" && Number(transaction.debit) <= 0) return false;
  if (conditions.min_amount != null && amount < Number(conditions.min_amount)) return false;
  if (conditions.max_amount != null && amount > Number(conditions.max_amount)) return false;
  return true;
}

r.post("/accounting/bank-rules/apply", require_("accounting.bank"), async (c) => {
  const sql = c.get("db");
  const rules = await sql`SELECT * FROM accounting_bank_rules WHERE is_active ORDER BY priority, created_at`;
  const transactions = await sql`
    SELECT bt.* FROM bank_transactions bt
    LEFT JOIN accounting_transaction_reviews rv
      ON rv.source_type = 'bank_transaction' AND rv.source_id = bt.id
    WHERE COALESCE(rv.status, 'review') = 'review'
    ORDER BY bt.txn_date DESC LIMIT 500`;
  let suggested = 0;
  let exact = 0;
  for (const transaction of transactions) {
    const amount = cents(Math.max(Number(transaction.debit), Number(transaction.credit)));
    let patch = null;
    if (Number(transaction.credit) > 0) {
      const [receipt] = await sql`
        SELECT id FROM ar_receipts WHERE amount = ${amount}
          AND received_date BETWEEN (${transaction.txn_date}::date - 5) AND (${transaction.txn_date}::date + 5)
        ORDER BY ABS(received_date - ${transaction.txn_date}::date) LIMIT 1`;
      if (receipt) patch = { status: "review", suggested_type: "ar_receipt",
        suggested_id: receipt.id, confidence: 1 };
    } else {
      const [payment] = await sql`
        SELECT id FROM ap_payments WHERE amount = ${amount}
          AND payment_date BETWEEN (${transaction.txn_date}::date - 5) AND (${transaction.txn_date}::date + 5)
        ORDER BY ABS(payment_date - ${transaction.txn_date}::date) LIMIT 1`;
      if (payment) patch = { status: "review", suggested_type: "ap_payment",
        suggested_id: payment.id, confidence: 1 };
    }
    if (patch) exact++;
    if (!patch) {
      const rule = rules.find((candidate) => ruleMatches(candidate, transaction));
      if (rule) {
        const actions = json(rule.actions);
        patch = { status: rule.auto_confirm && actions.gl_code ? "matched" : "review",
          suggested_type: "gl_account", suggested_gl: actions.gl_code || null,
          confidence: 0.85, rule_id: rule.id, note: `Rule: ${rule.name}` };
      }
    }
    if (patch) { await putReview(sql, "bank_transaction", transaction.id, patch); suggested++; }
  }
  await audit(c, { action: "accounting.bank_rules.apply", entityType: "bank_transaction",
    entityId: "batch", after: { scanned: transactions.length, suggested, exact } });
  return c.json({ scanned: transactions.length, suggested, exact });
});

/* ---------- Quick add ---------- */

r.post("/accounting/quick-add", require_("accounting.post"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const user = c.get("user");
  const kind = body.kind;
  let result;

  if (kind === "vendor") {
    if (!String(body.name ?? "").trim()) return c.json({ code: "VENDOR_NAME_REQUIRED" }, 400);
    [result] = await sql`
      INSERT INTO vendors (id, name, contact, email, phone, default_gl, payment_terms, note)
      VALUES (${uid("vn_")}, ${String(body.name).trim()}, ${body.contact || null},
        ${body.email || null}, ${body.phone || null}, ${body.gl_code || null},
        ${Number(body.payment_terms) || 30}, ${body.note || null}) RETURNING *`;
  } else if (kind === "bill") {
    const amount = cents(body.amount);
    const gst = cents(body.gst || 0);
    if (!body.vendor_id || !body.invoice_no || !body.date || !body.due_date || !body.gl_code || !amount)
      return c.json({ code: "BILL_FIELDS_REQUIRED" }, 400);
    const id = uid("api_");
    result = await sql.begin(async (tx) => {
      const [invoice] = await tx`
        INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date, due_date,
          building_code, unit_number, subtotal, gst, total, description, state,
          paid_amount, created_by, review_state)
        VALUES (${id}, ${body.vendor_id}, ${String(body.invoice_no).trim()}, ${body.date},
          ${body.due_date}, ${body.building_code || null}, ${body.unit_number || null},
          ${amount}, ${gst}, ${cents(amount + gst)}, ${body.memo || null}, 'draft', 0,
          ${user.id}, 'pending') RETURNING *`;
      await tx`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code, description,
        amount, building_code, unit_number) VALUES (${uid("apl_")}, ${id}, 1,
        ${body.gl_code}, ${body.memo || "Expense"}, ${amount}, ${body.building_code || null},
        ${body.unit_number || null})`;
      return invoice;
    });
  } else if (["expense", "income"].includes(kind)) {
    const amount = cents(body.amount);
    if (!body.date || !body.gl_code || !body.bank_gl || !amount)
      return c.json({ code: "TRANSACTION_FIELDS_REQUIRED" }, 400);
    result = await postJournal(sql, user, {
      date: body.date, building_code: body.building_code, source: `quick_${kind}`,
      memo: body.memo || `Quick add ${kind}`,
      lines: kind === "expense" ? [
        { gl_code: body.gl_code, debit: amount, credit: 0, vendor_id: body.vendor_id },
        { gl_code: body.bank_gl, debit: 0, credit: amount },
      ] : [
        { gl_code: body.bank_gl, debit: amount, credit: 0 },
        { gl_code: body.gl_code, debit: 0, credit: amount },
      ],
    });
  } else if (kind === "tenant_receipt") {
    const amount = cents(body.amount);
    if (!body.date || !body.unit_number || !body.bank_gl || !amount)
      return c.json({ code: "RECEIPT_FIELDS_REQUIRED" }, 400);
    const id = uid("rc_");
    const entry = await postJournal(sql, user, { date: body.date, source: "ar_receipt",
      source_id: id, building_code: body.building_code, memo: body.memo || `Receipt ${body.unit_number}`,
      lines: [
        { gl_code: body.bank_gl, debit: amount, credit: 0, unit_number: body.unit_number },
        { gl_code: "1100", debit: 0, credit: amount, unit_number: body.unit_number },
      ] });
    [result] = await sql`
      INSERT INTO ar_receipts (id, unit_number, building_code, received_date, amount,
        method, reference, deposit_to, entry_id, note, created_by)
      VALUES (${id}, ${body.unit_number}, ${body.building_code || null}, ${body.date},
        ${amount}, ${body.method || "etransfer"}, ${body.reference || null},
        ${body.bank_gl}, ${entry.id}, ${body.memo || null}, ${user.id}) RETURNING *`;
  } else if (kind === "journal") {
    result = await postJournal(sql, user, body);
  } else return c.json({ code: "INVALID_QUICK_ADD_KIND" }, 400);

  await audit(c, { action: `accounting.quick_add.${kind}`, entityType: kind,
    entityId: result.id, after: result });
  return c.json({ result }, 201);
});

/* ---------- Receipt and invoice capture ---------- */

r.get("/accounting/captures", require_("accounting.view"), async (c) => {
  const captures = await c.get("db")`SELECT * FROM accounting_captures ORDER BY created_at DESC LIMIT 100`;
  for (const capture of captures) capture.extracted = json(capture.extracted);
  return c.json({ captures });
});

r.post("/accounting/captures", require_("accounting.ap"), async (c) => {
  if (!c.env.FILES) return c.json({ code: "FILE_STORAGE_NOT_CONFIGURED" }, 503);
  const body = await c.req.parseBody().catch(() => ({}));
  const file = body.file;
  if (!file || typeof file.arrayBuffer !== "function") return c.json({ code: "FILE_REQUIRED" }, 400);
  if (!CAPTURE_TYPES.has(file.type)) return c.json({ code: "FILE_TYPE_NOT_ALLOWED" }, 415);
  if (file.size <= 0 || file.size > MAX_CAPTURE_BYTES)
    return c.json({ code: "FILE_SIZE_NOT_ALLOWED", max_bytes: MAX_CAPTURE_BYTES }, 413);
  const documentType = ["receipt", "vendor_invoice", "bank_document", "other"].includes(body.document_type)
    ? body.document_type : "receipt";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = uid("cap_");
  const filename = safeFilename(file.name, "capture");
  const storageKey = `accounting/captures/${id}/${filename}`;
  await c.env.FILES.put(storageKey, bytes, { httpMetadata: { contentType: file.type },
    customMetadata: { capture_id: id, sha256: digest } });

  let extracted = {};
  let status = "needs_review";
  let note = file.type === "application/pdf"
    ? "PDF saved. Confirm the fields before creating a transaction." : "Vision extraction is not configured.";
  if (file.type.startsWith("image/") && c.env.AI) {
    try {
      const response = await c.env.AI.run(
        c.env.ACCOUNTING_VISION_MODEL || "@cf/llava-hf/llava-1.5-7b-hf", {
          image: [...bytes],
          prompt: "Read this receipt or invoice. Return only JSON with vendor, invoice_no, date (YYYY-MM-DD), due_date (YYYY-MM-DD), subtotal, tax, total, currency, description. Use null when unreadable. Never invent a value.",
          max_tokens: 500,
        });
      const text = String(response?.description ?? response?.response ?? "")
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      extracted = json(text, { raw_text: text.slice(0, 3000) });
      status = Object.values(extracted).some((value) => value != null && value !== "") ? "ready" : "needs_review";
      note = status === "ready" ? "Cloudflare Workers AI extracted draft fields. Confirm before posting."
        : "No reliable fields were found. Enter them manually.";
    } catch (error) {
      note = `Vision extraction unavailable (${String(error?.message || "unknown").slice(0, 120)}). Enter the fields manually.`;
    }
  }
  const user = c.get("user");
  const [capture] = await c.get("db")`
    INSERT INTO accounting_captures (id, document_type, filename, storage_key,
      mime_type, size_bytes, sha256, status, extracted, extraction_note,
      uploaded_by, uploaded_name)
    VALUES (${id}, ${documentType}, ${filename}, ${storageKey}, ${file.type},
      ${bytes.byteLength}, ${digest}, ${status}, ${JSON.stringify(extracted)}, ${note},
      ${user.id}, ${user.name}) RETURNING *`;
  await audit(c, { action: "accounting.capture.upload", entityType: "accounting_capture",
    entityId: capture.id, after: { status, document_type: documentType, filename } });
  capture.extracted = json(capture.extracted);
  return c.json({ capture }, 201);
});

r.patch("/accounting/captures/:id", require_("accounting.ap"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const user = c.get("user");
  const [before] = await sql`SELECT * FROM accounting_captures WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const status = ["ready", "needs_review", "converted", "failed"].includes(body.status)
    ? body.status : before.status;
  const [capture] = await sql`
    UPDATE accounting_captures SET extracted = ${JSON.stringify(body.extracted ?? json(before.extracted))},
      status = ${status}, extraction_note = ${body.note ?? before.extraction_note},
      linked_type = ${body.linked_type ?? before.linked_type},
      linked_id = ${body.linked_id ?? before.linked_id}, reviewed_by = ${user.id},
      reviewed_at = now(), updated_at = now() WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "accounting.capture.review", entityType: "accounting_capture",
    entityId: capture.id, before, after: capture });
  capture.extracted = json(capture.extracted);
  return c.json({ capture });
});

r.get("/accounting/captures/:id/file", require_("accounting.view"), async (c) => {
  const [capture] = await c.get("db")`SELECT * FROM accounting_captures WHERE id = ${c.req.param("id")}`;
  if (!capture) return c.json({ code: "NOT_FOUND" }, 404);
  const object = await c.env.FILES?.get(capture.storage_key);
  if (!object) return c.json({ code: "FILE_NOT_FOUND" }, 404);
  return new Response(object.body, { headers: { "Content-Type": capture.mime_type,
    "Content-Disposition": `inline; filename="${safeFilename(capture.filename)}"`,
    "Cache-Control": "private, no-store" } });
});

/* ---------- Provider readiness ---------- */

r.get("/accounting/integrations", require_("accounting.view"), (c) => c.json({
  bank_feed: { configured: !!(c.env.BANK_FEED_PROVIDER && c.env.BANK_FEED_SECRET),
    provider: c.env.BANK_FEED_PROVIDER || null },
  online_payments: { configured: !!(c.env.PAYMENT_PROVIDER && c.env.PAYMENT_PROVIDER_SECRET),
    provider: c.env.PAYMENT_PROVIDER || null },
  note: "Provider credentials stay in Cloudflare secrets; accounting records stay in Supabase.",
}));

r.post("/accounting/integrations/:kind/sync", require_("accounting.bank"), async (c) => {
  const kind = c.req.param("kind");
  const configured = kind === "bank_feed"
    ? !!(c.env.BANK_FEED_PROVIDER && c.env.BANK_FEED_SECRET)
    : kind === "online_payments" && !!(c.env.PAYMENT_PROVIDER && c.env.PAYMENT_PROVIDER_SECRET);
  if (!configured) return c.json({ code: "PROVIDER_NOT_CONFIGURED", kind }, 503);
  return c.json({ code: "PROVIDER_ADAPTER_REQUIRED", kind }, 501);
});

export default r;
