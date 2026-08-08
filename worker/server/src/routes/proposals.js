import { Router } from "express";
import { db, uid, nowISO, cents, txn } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { postEntry } from "./accounting.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   AI proposals

   Nothing the AI produces applies itself. Every task that would
   change something writes a proposal, and a person confirms it.

   One queue rather than a flag on each feature. The question
   somebody actually has is "what is waiting on me", and a
   confirmation list spread across six screens is one nobody works
   through.

   Some proposals need two people. An arrears sequence needs the
   Property Manager who knows the tenant and the Admin who owns the
   consequence; either alone is somebody deciding on their own what
   the other would have questioned.
   ============================================================ */

const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const today = () => new Date().toISOString().slice(0, 10);

/* Who has to confirm what, and how long a proposal stays useful.
   A bank match on a statement three weeks old is a match against a
   reconciliation somebody has already finished. */
export const PROPOSAL_KINDS = {
  bank_match: {
    label: "Bank statement matches", roles: ["accounting"], ttlDays: 14,
    describe: "Lines matched by reading the description. A wrong match shows up as an out-of-balance reconciliation, which is why this one is safe to propose in bulk.",
  },
  invoice_extract: {
    label: "Invoice read from a PDF", roles: ["accounting"], ttlDays: 30,
    describe: "Entered as a draft bill. The invoice sits beside it while you check, and nothing posts until you approve the bill in the usual way.",
    movesMoney: true,
  },
  csv_mapping: {
    label: "Bank export column layout", roles: ["accounting"], ttlDays: 7,
    describe: "Which column is which. The opening-plus-movement-equals-closing check catches a wrong mapping immediately.",
  },
  ap_anomaly: {
    label: "Payables worth a second look", roles: ["accounting"], ttlDays: 30,
    describe: "Things to check, not findings. Most turn out to be routine, and that is the point — the ones that do not are what this is for.",
  },
  variance_commentary: {
    label: "Month-on-month commentary", roles: ["accounting"], ttlDays: 60,
    describe: "Written from figures already computed. It explains movement and never recalculates.",
  },
  maintenance_triage: {
    label: "Repair sorted and vendors suggested", roles: ["building_manager"], ttlDays: 7,
    describe: "Category and who to send. Urgency is not set here — that stays with whoever can see the leak.",
  },
  quote_comparison: {
    label: "Quotes compared", roles: ["building_manager"], ttlDays: 30,
    describe: "What each includes and excludes, side by side. No recommendation: the cheapest quote is often the one that excludes the most.",
  },
  nl_query: {
    // Accounting asks most of these, so they confirm their own. Admin can
    // stand in like anywhere else.
    label: "Question answered from the ledger", roles: ["accounting"], ttlDays: 7,
    describe: "The SQL is shown with the answer. A query nobody can see is an answer nobody can check.",
  },
  lease_abstract: {
    // Two people: the Property Manager knows what was agreed, Admin owns the
    // library the file came from. A wrong end date propagates into every
    // renewal reminder after it.
    label: "Lease terms extracted", roles: ["property_manager", "admin"], ttlDays: 30,
    describe: "Populates a draft. The signed file stays the authority — this is an index of it, not a replacement.",
    movesMoney: true,
  },
  turnover_estimate: {
    // The Building Manager has seen the suite. An estimate confirmed without
    // that is an estimate from a spreadsheet.
    label: "Turnover cost estimated", roles: ["building_manager", "admin"], ttlDays: 30,
    describe: "A range from this property's own history, with the sample size shown. Fewer than ten past turnovers is not enough to be confident about.",
  },
  arrears_sequence: {
    // Two people. The Property Manager knows the tenant; Admin owns the
    // consequence of a message that lands wrong.
    label: "Arrears message drafted", roles: ["property_manager", "admin"], ttlDays: 7,
    describe: "Collections only. Nothing about ending a tenancy, which is a legal process with its own notice periods.",
    reachesTenant: true,
  },
};

/* ---------- Creating ---------- */

r.post("/proposals", require_("notifications.view"), (req, res) => {
  const { kind, title, summary, payload, inputs, method, model, confidence,
          ref_type, ref_id, building_code, unit_number, amount } = req.body ?? {};
  const spec = PROPOSAL_KINDS[kind];
  if (!spec) return res.status(400).json({ code: "UNKNOWN_KIND", kind });
  if (!payload) return res.status(400).json({ code: "PAYLOAD_REQUIRED" });

  const id = uid("prp_");
  const expires = new Date(Date.now() + spec.ttlDays * 864e5).toISOString();

  db.prepare(`INSERT INTO ai_proposals (id, kind, title, summary, payload, inputs, method,
    model, confidence, ref_type, ref_id, building_code, unit_number, amount,
    required_roles, reaches_tenant, moves_money, expires_at, created_by, created_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, title ?? spec.label, summary ?? null,
         JSON.stringify(payload), inputs ? JSON.stringify(inputs) : null,
         method ?? null, model ?? "claude-sonnet-4-6", confidence ?? "medium",
         ref_type ?? null, ref_id ?? null, building_code ?? null, unit_number ?? null,
         amount ?? null, JSON.stringify(spec.roles),
         spec.reachesTenant ? 1 : 0, spec.movesMoney ? 1 : 0, expires,
         req.user.id, req.user.name);

  // Whoever has to confirm hears about it. A queue nobody is told about is a
  // queue that fills up.
  for (const role of spec.roles)
    notify(role, "proposal", "PROPOSAL_WAITING",
           { kind: spec.label, title: title ?? spec.label }, "/confirmations");

  audit(req, { action: "proposal.create", entityType: "ai_proposal", entityId: id,
               after: { kind, roles: spec.roles, confidence } });
  res.status(201).json({ id, required_roles: spec.roles, expires_at: expires });
});

/* ---------- The queue ---------- */

/** Everything waiting, everything done. One place, because the question is
 *  "what is waiting on me" and that has to be answerable without opening six
 *  screens. */
r.get("/proposals", require_("notifications.view"), (req, res) => {
  const { state, kind, mine, limit = 200 } = req.query;

  let sql = "SELECT * FROM ai_proposals WHERE 1=1";
  const args = [];
  if (state && state !== "all") { sql += " AND state = ?"; args.push(state); }
  if (kind) { sql += " AND kind = ?"; args.push(kind); }
  sql += " ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));

  const rows = db.prepare(sql).all(...args);
  const confirmations = db.prepare("SELECT * FROM proposal_confirmations").all();

  const enriched = rows.map((p) => {
    const required = parse(p.required_roles, []);
    const given = confirmations.filter((c) => c.proposal_id === p.id);
    const outstanding = required.filter((role) => !given.some((c) => c.role_code === role));
    const expired = p.state === "pending" && p.expires_at && p.expires_at < nowISO();
    return {
      ...p,
      payload: parse(p.payload, null),
      inputs: parse(p.inputs, null),
      required_roles: required,
      confirmations: given,
      outstanding_roles: outstanding,
      // Whether this person can move it forward, which is what decides
      // whether it appears in their list.
      yours: outstanding.includes(req.user.role) || req.user.role === "admin",
      already_confirmed: given.some((c) => c.user_id === req.user.id),
      expired,
      state: expired ? "expired" : p.state,
    };
  });

  const filtered = mine === "1" ? enriched.filter((p) => p.yours && p.state === "pending")
                                : enriched;

  res.json({
    proposals: filtered,
    counts: {
      pending: enriched.filter((p) => p.state === "pending").length,
      // The number that decides whether somebody opens this screen today.
      yours: enriched.filter((p) => p.state === "pending" && p.yours
        && !p.already_confirmed).length,
      applied: enriched.filter((p) => p.state === "applied").length,
      rejected: enriched.filter((p) => p.state === "rejected").length,
      expired: enriched.filter((p) => p.state === "expired").length,
      reaches_tenant: enriched.filter((p) => p.state === "pending" && p.reaches_tenant).length,
    },
    kinds: Object.entries(PROPOSAL_KINDS).map(([k, v]) => ({ kind: k, ...v })),
  });
});

r.get("/proposals/:id", require_("notifications.view"), (req, res) => {
  const p = db.prepare("SELECT * FROM ai_proposals WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  res.json({
    proposal: { ...p, payload: parse(p.payload, null), inputs: parse(p.inputs, null),
                required_roles: parse(p.required_roles, []) },
    confirmations: db.prepare("SELECT * FROM proposal_confirmations WHERE proposal_id=?")
      .all(p.id).map((c) => ({ ...c, edited_payload: parse(c.edited_payload, null) })),
    spec: PROPOSAL_KINDS[p.kind] ?? null,
  });
});

/* ---------- Confirming ---------- */

/**
 * One person confirming. Where two are needed, the second call is what moves
 * it to confirmed.
 *
 * An edit is recorded as an edit. Somebody who changed the amount before
 * confirming has not confirmed the AI's figure, and the difference between
 * those two is exactly what tells you whether the model is any good.
 */
r.post("/proposals/:id/confirm", require_("notifications.view"), (req, res) => {
  try {
    const out = txn(() => {
      const p = db.prepare("SELECT * FROM ai_proposals WHERE id=?").get(req.params.id);
      if (!p) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (p.state !== "pending")
        throw Object.assign(new Error("NOT_PENDING"), { status: 409, state: p.state });
      if (p.expires_at && p.expires_at < nowISO()) {
        db.prepare("UPDATE ai_proposals SET state='expired' WHERE id=?").run(p.id);
        throw Object.assign(new Error("EXPIRED"), { status: 410 });
      }

      const required = parse(p.required_roles, []);
      const role = req.user.role;
      // Admin can stand in for any role, because with four people somebody is
      // always away and a queue that stalls on absence is a queue that gets
      // worked around.
      const standingIn = !required.includes(role) && role === "admin";
      if (!required.includes(role) && !standingIn)
        throw Object.assign(new Error("NOT_YOUR_CONFIRMATION"),
          { status: 403, required });

      const asRole = required.includes(role) ? role
        : required.find((rr) => !db.prepare(`SELECT 1 FROM proposal_confirmations
            WHERE proposal_id=? AND role_code=?`).get(p.id, rr));
      if (!asRole) throw Object.assign(new Error("ALREADY_CONFIRMED"), { status: 409 });

      const edited = req.body?.edited_payload != null;
      db.prepare(`INSERT INTO proposal_confirmations (id, proposal_id, role_code, user_id,
        user_name, edited, edited_payload, note) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(proposal_id, role_code) DO UPDATE SET user_id=excluded.user_id,
        user_name=excluded.user_name, edited=excluded.edited,
        edited_payload=excluded.edited_payload, note=excluded.note, at=datetime('now')`)
        .run(uid("pc_"), p.id, asRole, req.user.id, req.user.name, edited ? 1 : 0,
             edited ? JSON.stringify(req.body.edited_payload) : null,
             req.body?.note ?? null);

      const given = db.prepare("SELECT role_code FROM proposal_confirmations WHERE proposal_id=?")
        .all(p.id).map((c) => c.role_code);
      const outstanding = required.filter((rr) => !given.includes(rr));

      if (outstanding.length === 0) {
        db.prepare("UPDATE ai_proposals SET state='confirmed' WHERE id=?").run(p.id);
        if (p.reaches_tenant)
          notify("property_manager", "proposal", "PROPOSAL_READY_TO_SEND",
                 { title: p.title }, "/confirmations");
      } else {
        // Tell the other person it is on them now.
        for (const rr of outstanding)
          notify(rr, "proposal", "PROPOSAL_NEEDS_YOU", { title: p.title }, "/confirmations");
      }

      return { confirmed_as: asRole, standing_in: standingIn,
               outstanding, complete: outstanding.length === 0, edited };
    })();

    audit(req, { action: "proposal.confirm", entityType: "ai_proposal",
                 entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, state: e.state,
                                        required: e.required });
  }
});

r.post("/proposals/:id/reject", require_("notifications.view"), (req, res) => {
  const reason = String(req.body?.reason ?? "").trim();
  // The reason is the whole value of a rejection. Without it there is nothing
  // to learn from and the same proposal comes back next month.
  if (!reason) return res.status(400).json({ code: "REASON_REQUIRED" });

  const p = db.prepare("SELECT * FROM ai_proposals WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  if (p.state !== "pending") return res.status(409).json({ code: "NOT_PENDING" });

  db.prepare(`UPDATE ai_proposals SET state='rejected', rejected_by=?, rejected_name=?,
    rejected_reason=?, rejected_at=? WHERE id=?`)
    .run(req.user.id, req.user.name, reason, nowISO(), p.id);
  audit(req, { action: "proposal.reject", entityType: "ai_proposal", entityId: p.id,
               after: { reason, by: req.user.name } });
  res.json({ ok: true });
});

/* ---------- Applying ---------- */

/**
 * A confirmed proposal does the thing.
 *
 * Kept separate from confirming on purpose. Confirming says the content is
 * right; applying is when it takes effect, and for anything that reaches a
 * tenant or moves money those are worth being two deliberate acts.
 */
r.post("/proposals/:id/apply", require_("notifications.view"), (req, res) => {
  try {
    const out = txn(() => {
      const p = db.prepare("SELECT * FROM ai_proposals WHERE id=?").get(req.params.id);
      if (!p) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (p.state !== "confirmed")
        throw Object.assign(new Error("NOT_CONFIRMED"), { status: 409, state: p.state });

      // The edited version wins where somebody changed it. Applying the AI's
      // original after a person corrected it would be the worst of both.
      const edit = db.prepare(`SELECT edited_payload FROM proposal_confirmations
        WHERE proposal_id=? AND edited=1 ORDER BY at DESC LIMIT 1`).get(p.id);
      const payload = edit ? parse(edit.edited_payload, null) : parse(p.payload, null);

      const result = applyProposal(p, payload, req);

      db.prepare(`UPDATE ai_proposals SET state='applied', applied_at=?, applied_note=?
        WHERE id=?`).run(nowISO(), JSON.stringify(result), p.id);
      return result;
    })();

    audit(req, { action: "proposal.apply", entityType: "ai_proposal",
                 entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, state: e.state,
                                        detail: e.detail });
  }
});

/** What each kind does when applied. Everything here goes through the same
 *  path the manual version uses — a proposal is a shortcut to filling a form,
 *  not a second way in. */
function applyProposal(p, payload, req) {
  switch (p.kind) {
    case "bank_match": {
      let matched = 0;
      const up = db.prepare(`UPDATE bank_transactions SET matched_type=?, matched_id=?,
        matched_by=? WHERE id=?`);
      for (const m of payload?.matches ?? []) {
        up.run(m.record_type, m.record_id, req.user.name, m.transaction_id);
        matched++;
      }
      return { matched };
    }

    case "invoice_extract": {
      // A draft bill, not a posted one. Approving it stays a separate step,
      // which is where the duplicate check and the period lock already live.
      const id = uid("ap_");
      db.prepare(`INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date,
        due_date, unit_number, subtotal, gst, total, description, created_by, state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft')`)
        .run(id, payload.vendor_id ?? null, payload.invoice_no,
             payload.invoice_date ?? today(), payload.due_date ?? today(),
             payload.unit_number ?? null, cents(payload.subtotal ?? 0),
             cents(payload.gst ?? 0), cents(payload.total ?? 0),
             `${payload.vendor_name ?? ""} (read from PDF)`, req.user.id);
      const insL = db.prepare(`INSERT INTO ap_invoice_lines (id, invoice_id, line_no,
        gl_code, description, amount) VALUES (?,?,?,?,?,?)`);
      (payload.lines ?? []).forEach((l, i) =>
        insL.run(uid("al_"), id, i + 1, l.gl_code ?? "5010", l.description ?? "",
                 cents(l.amount)));
      return { bill_id: id, state: "draft",
               note: "Created as a draft. It posts when Accounting approves it." };
    }

    case "maintenance_triage": {
      db.prepare(`UPDATE maintenance SET category=COALESCE(?,category),
        vendor=COALESCE(?,vendor) WHERE id=?`)
        .run(payload.category ?? null, payload.suggested_vendors?.[0] ?? null, p.ref_id);
      if (payload.safety_note)
        db.prepare(`INSERT INTO maintenance_notes (id, ticket_id, body, by_name)
          VALUES (?,?,?,'triage')`)
          .run(uid("mn_"), p.ref_id, `Safety note: ${payload.safety_note}`);
      return { ticket: p.ref_id, category: payload.category };
    }

    case "lease_abstract": {
      const id = uid("la_");
      db.prepare(`INSERT INTO lease_abstracts (id, unit_number, fields, state,
        confirmed_by, confirmed_at) VALUES (?,?,?, 'confirmed', ?, ?)`)
        .run(id, p.unit_number, JSON.stringify(payload.fields ?? {}),
             req.user.id, nowISO());
      return { abstract_id: id };
    }

    case "arrears_sequence": {
      const contact = p.unit_number
        ? db.prepare(`SELECT c.* FROM leases l JOIN contacts c ON c.id = l.primary_contact_id
            WHERE l.unit_number=? AND l.status='active' LIMIT 1`).get(p.unit_number) : null;
      if (!contact?.email)
        throw Object.assign(new Error("NO_EMAIL"), { status: 400,
          detail: "No email on file for this unit." });
      const msg = db.prepare(`INSERT INTO outbox (id, channel, to_email, to_name, locale,
        kind, subject, body, ref_type, ref_id, created_by)
        VALUES (?, 'email', ?,?,?, 'arrears', ?,?, 'proposal', ?, ?)`);
      const oid = uid("ob_");
      msg.run(oid, contact.email, contact.full_name, contact.locale ?? "en",
              payload.subject, payload.body, p.id, req.user.id);
      return { queued_to: contact.email, outbox_id: oid };
    }

    case "turnover_estimate": {
      if (!p.ref_id) return { note: "Recorded. Not attached to a turnover." };
      db.prepare(`UPDATE turnovers SET note = COALESCE(note || char(10), '') || ?
        WHERE id=?`)
        .run(`Estimate: ${payload.cost_low}–${payload.cost_high} over ${payload.days_low}–${payload.days_high} days, from ${payload.based_on} past turnovers.`,
             p.ref_id);
      return { turnover: p.ref_id };
    }

    // Reading, not changing. Confirming is the whole of it.
    case "ap_anomaly":
    case "variance_commentary":
    case "quote_comparison":
    case "csv_mapping":
    case "nl_query":
      return { note: "Recorded. Nothing to apply — this one is for reading." };

    default:
      throw Object.assign(new Error("NO_APPLY_HANDLER"), { status: 400, kind: p.kind });
  }
}

/* ---------- Read-only queries ---------- */

/** Runs a query the AI wrote, after somebody has seen the SQL.
 *
 *  Read-only, one statement, and the SQL travels with the answer. A query
 *  nobody can see is an answer nobody can check, and text-to-SQL is very good
 *  at answering a nearby question convincingly. */
r.post("/queries/run", require_("accounting.view"), (req, res) => {
  const sql = String(req.body?.sql ?? "").trim();
  const question = req.body?.question ?? null;
  if (!sql) return res.status(400).json({ code: "SQL_REQUIRED" });

  // Belt and braces on top of the prompt. The prompt says SELECT only; this
  // makes it true.
  const lowered = sql.toLowerCase();
  const banned = ["insert", "update", "delete", "drop", "alter", "create", "replace",
                  "attach", "detach", "pragma", "vacuum", "reindex", ";"];
  const hit = banned.find((b) => lowered.includes(b));
  if (hit) return res.status(400).json({ code: "NOT_READ_ONLY", found: hit });
  if (!lowered.startsWith("select") && !lowered.startsWith("with"))
    return res.status(400).json({ code: "MUST_BE_SELECT" });

  const started = Date.now();
  try {
    const rows = db.prepare(`${sql} LIMIT 500`).all();
    const ms = Date.now() - started;
    db.prepare(`INSERT INTO query_log (id, question, sql_text, row_count, result_json,
      ms, asked_by, asked_name) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid("q_"), question, sql, rows.length,
           JSON.stringify(rows.slice(0, 50)), ms, req.user.id, req.user.name);
    audit(req, { action: "query.run", entityType: "query", entityId: null,
                 after: { rows: rows.length, ms } });
    res.json({ rows, count: rows.length, ms, sql,
      note: rows.length === 500
        ? "Capped at 500 rows. Narrow the question if you need all of them."
        : null });
  } catch (e) {
    db.prepare(`INSERT INTO query_log (id, question, sql_text, error, asked_by, asked_name)
      VALUES (?,?,?,?,?,?)`)
      .run(uid("q_"), question, sql, e.message, req.user.id, req.user.name);
    res.status(400).json({ code: "QUERY_FAILED", detail: e.message });
  }
});

/** The tables the AI is allowed to write queries against. Deliberately narrow:
 *  no users, no sessions, no contacts, nothing holding a password or an
 *  address. A question that needs those is a question for a person. */
r.get("/queries/schema", require_("accounting.view"), (req, res) => {
  const allowed = ["journal_entries", "journal_lines", "gl_accounts", "ar_charges",
    "ar_receipts", "ar_applications", "ap_invoices", "ap_invoice_lines", "vendors",
    "units", "unit_types", "buildings", "leases", "maintenance", "purchase_orders",
    "turnovers", "events", "showing_outcomes", "fee_calculations", "payroll_runs",
    "bank_statements", "bank_transactions", "accounting_periods"];

  const schema = allowed.map((t) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    return cols.length ? `${t}(${cols.map((c) => c.name).join(", ")})` : null;
  }).filter(Boolean);

  res.json({ tables: allowed, schema: schema.join("\n"),
    note: "Ledger and operations only. Nothing holding personal contact details or credentials." });
});

r.get("/queries/history", require_("accounting.view"), (req, res) => {
  res.json({ queries: db.prepare(`SELECT * FROM query_log ORDER BY created_at DESC
    LIMIT 50`).all().map((q) => ({ ...q, result_json: parse(q.result_json, []) })) });
});

/* ---------- Vendor quotes ---------- */

r.get("/quotes", require_("units.view"), (req, res) => {
  const { ticket_id } = req.query;
  const rows = ticket_id
    ? db.prepare("SELECT * FROM vendor_quotes WHERE ticket_id=? ORDER BY amount").all(ticket_id)
    : db.prepare("SELECT * FROM vendor_quotes ORDER BY created_at DESC LIMIT 200").all();
  res.json({ quotes: rows });
});

r.post("/quotes", require_("po.create"), (req, res) => {
  const { ticket_id, vendor_id, vendor_name, amount, received_on, valid_until,
          lead_time_days, scope, exclusions, notes } = req.body ?? {};
  if (!vendor_name?.trim()) return res.status(400).json({ code: "VENDOR_REQUIRED" });
  const id = uid("vq_");
  db.prepare(`INSERT INTO vendor_quotes (id, ticket_id, vendor_id, vendor_name, amount,
    received_on, valid_until, lead_time_days, scope, exclusions, notes, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ticket_id ?? null, vendor_id ?? null, vendor_name.trim(),
         amount == null ? null : cents(amount), received_on ?? today(),
         valid_until ?? null, lead_time_days ?? null, scope ?? null,
         exclusions ?? null, notes ?? null, req.user.id);
  audit(req, { action: "quote.add", entityType: "vendor_quote", entityId: id,
               after: { vendor_name, amount, ticket_id } });
  res.status(201).json({ id });
});

export default r;
