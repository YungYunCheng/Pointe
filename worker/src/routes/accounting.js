import { Hono } from "hono";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { require_, audit, uid } from "../lib/auth.js";

const r = new Hono();
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_FILES = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

const cents = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
};
const asJson = (value, fallback = {}) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const money = (value) => new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD",
}).format(Number(value) || 0);
const latin = (value) => String(value ?? "")
  .normalize("NFKD").replace(/[^\x20-\x7E]/g, "?");
const safeFilename = (value, fallback) => {
  const cleaned = String(value ?? "").replace(/[\r\n"\\/]/g, "_").trim();
  return (cleaned || fallback).slice(0, 180);
};
const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

function reviewerLane(user, requested) {
  if (user?.role === "accounting") return "accounting";
  if (user?.role === "property_manager") return "property_manager";
  if (user?.role === "admin" && ["accounting", "property_manager"].includes(requested))
    return requested;
  return null;
}

function entityType(value) {
  if (["invoice", "ap_invoice"].includes(value)) return "ap_invoice";
  if (["report", "monthly_report"].includes(value)) return "monthly_report";
  return null;
}

async function getEntity(sql, type, id, lock = false) {
  if (type === "ap_invoice") {
    const rows = lock
      ? await sql`SELECT * FROM ap_invoices WHERE id = ${id} FOR UPDATE`
      : await sql`SELECT * FROM ap_invoices WHERE id = ${id}`;
    return rows[0] ?? null;
  }
  const rows = lock
    ? await sql`SELECT * FROM monthly_reports WHERE id = ${id} FOR UPDATE`
    : await sql`SELECT * FROM monthly_reports WHERE id = ${id}`;
  return rows[0] ?? null;
}

async function currentFile(sql, type, id) {
  const [file] = await sql`
    SELECT * FROM accounting_document_files
    WHERE entity_type = ${type} AND entity_id = ${id} AND is_current
    LIMIT 1`;
  return file ?? null;
}

async function hydrateInvoice(sql, id) {
  const [invoice] = await sql`
    SELECT i.*, v.name AS vendor_name,
      COALESCE((SELECT json_agg(l ORDER BY l.line_no)
        FROM ap_invoice_lines l WHERE l.invoice_id = i.id), '[]'::json) AS lines,
      (SELECT row_to_json(f) FROM accounting_document_files f
        WHERE f.entity_type = 'ap_invoice' AND f.entity_id = i.id AND f.is_current
        LIMIT 1) AS file,
      COALESCE((SELECT json_agg(rv ORDER BY rv.reviewed_at DESC)
        FROM accounting_document_reviews rv
        WHERE rv.entity_type = 'ap_invoice' AND rv.entity_id = i.id), '[]'::json) AS reviews
    FROM ap_invoices i JOIN vendors v ON v.id = i.vendor_id
    WHERE i.id = ${id}`;
  return invoice ?? null;
}

async function hydrateReport(sql, id) {
  const [report] = await sql`
    SELECT m.*,
      (SELECT row_to_json(f) FROM accounting_document_files f
        WHERE f.entity_type = 'monthly_report' AND f.entity_id = m.id AND f.is_current
        LIMIT 1) AS file,
      COALESCE((SELECT json_agg(rv ORDER BY rv.reviewed_at DESC)
        FROM accounting_document_reviews rv
        WHERE rv.entity_type = 'monthly_report' AND rv.entity_id = m.id), '[]'::json) AS reviews
    FROM monthly_reports m WHERE m.id = ${id}`;
  if (report) report.figures = asJson(report.figures, {});
  return report ?? null;
}

function pdfWriter(title) {
  return (async () => {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let page;
    let y;
    const addPage = () => {
      page = pdf.addPage([612, 792]);
      y = 750;
      page.drawText(latin(title), { x: 48, y, size: 18, font: bold, color: rgb(0.08, 0.11, 0.15) });
      y -= 30;
    };
    addPage();
    const line = (value = "", opts = {}) => {
      const size = opts.size ?? 10;
      const font = opts.bold ? bold : regular;
      const maxWidth = opts.maxWidth ?? 516;
      const words = latin(value).split(/\s+/);
      let row = "";
      const rows = [];
      for (const word of words) {
        const next = row ? `${row} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > maxWidth && row) {
          rows.push(row); row = word;
        } else row = next;
      }
      rows.push(row);
      for (const text of rows) {
        if (y < 55) addPage();
        page.drawText(text, { x: opts.x ?? 48, y, size, font,
          color: opts.muted ? rgb(0.38, 0.45, 0.52) : rgb(0.08, 0.11, 0.15) });
        y -= opts.leading ?? size + 5;
      }
      if (opts.after) y -= opts.after;
    };
    const rule = () => {
      if (y < 60) addPage();
      page.drawLine({ start: { x: 48, y }, end: { x: 564, y }, thickness: 0.7,
        color: rgb(0.82, 0.85, 0.88) });
      y -= 14;
    };
    return { pdf, line, rule };
  })();
}

async function invoicePdf(invoice, vendor, lines) {
  const w = await pdfWriter(`Vendor Invoice · ${invoice.invoice_no}`);
  w.line(`Vendor: ${vendor?.name ?? "-"}`, { bold: true, size: 12 });
  w.line(`Invoice date: ${invoice.invoice_date}    Due: ${invoice.due_date}`);
  w.line(`Building: ${invoice.building_code ?? "Shared"}    Unit: ${invoice.unit_number ?? "-"}`);
  if (invoice.description) w.line(`Description: ${invoice.description}`, { after: 6 });
  w.rule();
  w.line("DETAIL", { bold: true, muted: true });
  for (const item of lines) {
    w.line(`${item.gl_code}  ${item.description ?? "Expense"}  ·  ${money(item.amount)}`);
  }
  w.rule();
  w.line(`Subtotal: ${money(invoice.subtotal)}`, { bold: true });
  w.line(`GST: ${money(invoice.gst)}`, { bold: true });
  w.line(`Total: ${money(invoice.total)}`, { bold: true, size: 13, after: 14 });
  w.line("System-generated accounting copy. The original vendor document, when uploaded, remains unchanged.",
    { muted: true, size: 8 });
  return w.pdf.save();
}

async function reportPdf(report) {
  const figures = asJson(report.figures, {});
  const w = await pdfWriter(`Management Report · ${report.period} · Building ${report.building_code}`);
  w.line(`Period: ${report.period}    Building: ${report.building_code}`, { bold: true, size: 12 });
  w.rule();
  const pairs = [
    ["Revenue", figures.revenue_total], ["Expenses", figures.expense_total],
    ["Net operating income", figures.net_operating_income], ["Rent billed", figures.rent_billed],
    ["Rent collected", figures.rent_collected], ["Arrears", figures.arrears_total],
  ];
  for (const [label, value] of pairs) w.line(`${label}: ${money(value)}`, { bold: true });
  if (figures.collection_rate != null) w.line(`Collection rate: ${figures.collection_rate}%`);
  if (report.narrative) {
    w.rule(); w.line("COMMENTARY", { bold: true, muted: true });
    w.line(report.narrative, { leading: 15, after: 8 });
  }
  w.rule(); w.line("METHOD", { bold: true, muted: true });
  w.line(report.method ?? "", { size: 8, leading: 12 });
  return w.pdf.save();
}

async function replaceFile(c, type, id, { bytes, filename, mimeType, source }) {
  if (!c.env.FILES) throw Object.assign(new Error("FILE_STORAGE_NOT_CONFIGURED"), {
    status: 503, code: "FILE_STORAGE_NOT_CONFIGURED",
  });
  const sql = c.get("db");
  const user = c.get("user");
  const entity = await getEntity(sql, type, id);
  if (!entity) return null;

  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = hex(await crypto.subtle.digest("SHA-256", data));
  const key = `accounting/${type}/${id}/${crypto.randomUUID()}-${safeFilename(filename, "document.pdf")}`;
  await c.env.FILES.put(key, data, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { entity_type: type, entity_id: id, sha256: digest },
  });

  try {
    const file = await sql.begin(async (tx) => {
      const locked = await getEntity(tx, type, id, true);
      if (!locked) return null;
      const version = Number(locked.document_version ?? 0) + 1;
      await tx`UPDATE accounting_document_files SET is_current = FALSE
        WHERE entity_type = ${type} AND entity_id = ${id} AND is_current`;
      const [created] = await tx`
        INSERT INTO accounting_document_files (id, entity_type, entity_id, document_version,
          source, filename, storage_key, mime_type, size_bytes, sha256, is_current,
          uploaded_by, uploaded_name)
        VALUES (${uid("adf_")}, ${type}, ${id}, ${version}, ${source}, ${filename},
          ${key}, ${mimeType}, ${data.byteLength}, ${digest}, TRUE, ${user.id}, ${user.name})
        RETURNING *`;
      if (type === "ap_invoice") await tx`
        UPDATE ap_invoices SET document_version = ${version}, review_state = 'pending',
          accounting_reviewed_by = NULL, accounting_reviewed_name = NULL,
          accounting_reviewed_at = NULL, pm_reviewed_by = NULL,
          pm_reviewed_name = NULL, pm_reviewed_at = NULL, finalised_at = NULL
        WHERE id = ${id}`;
      else await tx`
        UPDATE monthly_reports SET document_version = ${version}, review_state = 'pending',
          state = 'review', accounting_reviewed_by = NULL, accounting_reviewed_name = NULL,
          accounting_reviewed_at = NULL, pm_reviewed_by = NULL,
          pm_reviewed_name = NULL, pm_reviewed_at = NULL, finalised_at = NULL
        WHERE id = ${id}`;
      return created;
    });
    if (!file) await c.env.FILES.delete(key);
    return file;
  } catch (error) {
    await c.env.FILES.delete(key);
    throw error;
  }
}

/* ---------- Shared review centre ---------- */

r.get("/accounting/review-center", require_("accounting.view"), async (c) => {
  const sql = c.get("db");
  const invoices = await sql`
    SELECT i.*, v.name AS vendor_name,
      COALESCE((SELECT json_agg(l ORDER BY l.line_no)
        FROM ap_invoice_lines l WHERE l.invoice_id = i.id), '[]'::json) AS lines,
      (SELECT row_to_json(f) FROM accounting_document_files f
        WHERE f.entity_type = 'ap_invoice' AND f.entity_id = i.id AND f.is_current LIMIT 1) AS file,
      COALESCE((SELECT json_agg(rv ORDER BY rv.reviewed_at DESC)
        FROM accounting_document_reviews rv
        WHERE rv.entity_type = 'ap_invoice' AND rv.entity_id = i.id), '[]'::json) AS reviews
    FROM ap_invoices i JOIN vendors v ON v.id = i.vendor_id
    ORDER BY i.created_at DESC`;
  const reports = await sql`
    SELECT m.*,
      (SELECT row_to_json(f) FROM accounting_document_files f
        WHERE f.entity_type = 'monthly_report' AND f.entity_id = m.id AND f.is_current LIMIT 1) AS file,
      COALESCE((SELECT json_agg(rv ORDER BY rv.reviewed_at DESC)
        FROM accounting_document_reviews rv
        WHERE rv.entity_type = 'monthly_report' AND rv.entity_id = m.id), '[]'::json) AS reviews
    FROM monthly_reports m ORDER BY m.period DESC, m.building_code`;
  for (const report of reports) report.figures = asJson(report.figures, {});
  const buildingAccounts = await sql`
    SELECT ba.building_code, ba.account_kind, ba.gl_code, ba.label,
      g.name_en AS account_name, g.is_trust, g.is_bank,
      COALESCE(SUM(CASE WHEN je.state = 'posted' THEN jl.debit - jl.credit ELSE 0 END), 0) AS balance
    FROM building_accounts ba
    JOIN gl_accounts g ON g.code = ba.gl_code
    LEFT JOIN journal_lines jl ON jl.gl_code = ba.gl_code
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ba.is_active
    GROUP BY ba.building_code, ba.account_kind, ba.gl_code, ba.label,
      g.name_en, g.is_trust, g.is_bank
    ORDER BY ba.building_code, ba.account_kind DESC`;
  return c.json({
    invoices, reports, building_accounts: buildingAccounts,
    vendors: await sql`SELECT * FROM vendors WHERE is_active ORDER BY name`,
    accounts: await sql`SELECT g.*, g.name_en AS name
      FROM gl_accounts g WHERE g.is_active ORDER BY g.code`,
  });
});

r.post("/accounting/ap/invoices", require_("accounting.ap"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const subtotal = cents(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const gst = cents(body.gst ?? 0);
  const total = cents((subtotal ?? 0) + (gst ?? 0));
  if (!body.vendor_id || !String(body.invoice_no ?? "").trim() || !body.invoice_date ||
      !body.due_date || subtotal == null || subtotal <= 0 || gst == null || gst < 0)
    return c.json({ code: "INVOICE_FIELDS_REQUIRED" }, 400);
  if (!lines.every((line) => line.gl_code && cents(line.amount) > 0))
    return c.json({ code: "VALID_INVOICE_LINES_REQUIRED" }, 400);
  const sql = c.get("db");
  const user = c.get("user");
  try {
    const invoice = await sql.begin(async (tx) => {
      const [vendor] = await tx`SELECT id FROM vendors WHERE id = ${body.vendor_id} AND is_active`;
      if (!vendor) return null;
      const id = uid("api_");
      const [created] = await tx`
        INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date, due_date,
          building_code, unit_number, subtotal, gst, total, description, state,
          paid_amount, created_by, review_state)
        VALUES (${id}, ${body.vendor_id}, ${String(body.invoice_no).trim()},
          ${body.invoice_date}, ${body.due_date}, ${body.building_code || null},
          ${body.unit_number || null}, ${subtotal}, ${gst}, ${total},
          ${body.description || null}, 'draft', 0, ${user.id}, 'pending') RETURNING *`;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        await tx`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
          description, amount, building_code, unit_number)
          VALUES (${uid("apl_")}, ${id}, ${index + 1}, ${line.gl_code},
            ${line.description || null}, ${cents(line.amount)}, ${body.building_code || null},
            ${body.unit_number || null})`;
      }
      return created;
    });
    if (!invoice) return c.json({ code: "ACTIVE_VENDOR_REQUIRED" }, 400);
    await audit(c, { action: "ap_invoice.create", entityType: "ap_invoice",
      entityId: invoice.id, after: { invoice_no: invoice.invoice_no, total: invoice.total } });
    return c.json({ invoice: await hydrateInvoice(sql, invoice.id) }, 201);
  } catch (error) {
    if (error?.code === "23505") return c.json({ code: "DUPLICATE_VENDOR_INVOICE" }, 409);
    throw error;
  }
});

r.post("/accounting/documents/:type/:id/upload", require_("accounting.review"), async (c) => {
  const type = entityType(c.req.param("type"));
  if (!type) return c.json({ code: "INVALID_DOCUMENT_TYPE" }, 400);
  const body = await c.req.parseBody().catch(() => ({}));
  const file = body.file;
  if (!file || typeof file.arrayBuffer !== "function")
    return c.json({ code: "FILE_REQUIRED" }, 400);
  if (!ALLOWED_FILES.has(file.type)) return c.json({ code: "FILE_TYPE_NOT_ALLOWED" }, 415);
  if (file.size <= 0 || file.size > MAX_FILE_BYTES)
    return c.json({ code: "FILE_SIZE_NOT_ALLOWED", max_bytes: MAX_FILE_BYTES }, 413);
  const saved = await replaceFile(c, type, c.req.param("id"), {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: safeFilename(file.name, `invoice.${ALLOWED_FILES.get(file.type)}`),
    mimeType: file.type, source: "uploaded",
  });
  if (!saved) return c.json({ code: "NOT_FOUND" }, 404);
  await audit(c, { action: "accounting_document.upload", entityType: type,
    entityId: c.req.param("id"), after: { file_id: saved.id, version: saved.document_version } });
  const document = type === "ap_invoice"
    ? await hydrateInvoice(c.get("db"), c.req.param("id"))
    : await hydrateReport(c.get("db"), c.req.param("id"));
  return c.json({ document }, 201);
});

r.post("/accounting/documents/:type/:id/generate", require_("accounting.review"), async (c) => {
  const type = entityType(c.req.param("type"));
  if (!type) return c.json({ code: "INVALID_DOCUMENT_TYPE" }, 400);
  const sql = c.get("db");
  const id = c.req.param("id");
  let bytes;
  let filename;
  if (type === "ap_invoice") {
    const invoice = await hydrateInvoice(sql, id);
    if (!invoice) return c.json({ code: "NOT_FOUND" }, 404);
    const [vendor] = await sql`SELECT * FROM vendors WHERE id = ${invoice.vendor_id}`;
    bytes = await invoicePdf(invoice, vendor, invoice.lines ?? []);
    filename = `Invoice-${safeFilename(invoice.invoice_no, id)}.pdf`;
  } else {
    const report = await hydrateReport(sql, id);
    if (!report) return c.json({ code: "NOT_FOUND" }, 404);
    bytes = await reportPdf(report);
    filename = `Management-Report-${report.period}-${report.building_code}.pdf`;
  }
  const saved = await replaceFile(c, type, id, {
    bytes, filename, mimeType: "application/pdf", source: "generated",
  });
  await audit(c, { action: "accounting_document.generate", entityType: type,
    entityId: id, after: { file_id: saved.id, version: saved.document_version } });
  const document = type === "ap_invoice"
    ? await hydrateInvoice(sql, id) : await hydrateReport(sql, id);
  return c.json({ document }, 201);
});

r.post("/accounting/documents/:type/:id/review", require_("accounting.review"), async (c) => {
  const type = entityType(c.req.param("type"));
  if (!type) return c.json({ code: "INVALID_DOCUMENT_TYPE" }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (!["approved", "changes_requested"].includes(body.decision))
    return c.json({ code: "INVALID_REVIEW_DECISION" }, 400);
  if (body.decision === "changes_requested" && !String(body.note ?? "").trim())
    return c.json({ code: "CHANGE_REASON_REQUIRED" }, 400);
  const user = c.get("user");
  const lane = reviewerLane(user, body.lane);
  if (!lane) return c.json({ code: "PM_OR_ACCOUNTING_REVIEW_REQUIRED" }, 403);
  const sql = c.get("db");
  const id = c.req.param("id");

  const outcome = await sql.begin(async (tx) => {
    const entity = await getEntity(tx, type, id, true);
    if (!entity) return null;
    const file = await currentFile(tx, type, id);
    if (!file || Number(file.document_version) !== Number(entity.document_version))
      return { error: "CURRENT_FILE_REQUIRED" };
    const otherReviewer = lane === "accounting"
      ? entity.pm_reviewed_by : entity.accounting_reviewed_by;
    if (body.decision === "approved" && otherReviewer === user.id)
      return { error: "TWO_DIFFERENT_REVIEWERS_REQUIRED" };

    await tx`INSERT INTO accounting_document_reviews (id, entity_type, entity_id,
      document_version, reviewer_lane, decision, note, reviewed_by, reviewed_name, reviewer_role)
      VALUES (${uid("adr_")}, ${type}, ${id}, ${entity.document_version}, ${lane},
        ${body.decision}, ${body.note || null}, ${user.id}, ${user.name}, ${user.role})`;

    if (body.decision === "changes_requested") {
      if (type === "ap_invoice") await tx`
        UPDATE ap_invoices SET review_state = 'changes_requested',
          accounting_reviewed_by = NULL, accounting_reviewed_name = NULL,
          accounting_reviewed_at = NULL, pm_reviewed_by = NULL,
          pm_reviewed_name = NULL, pm_reviewed_at = NULL, finalised_at = NULL
        WHERE id = ${id}`;
      else await tx`
        UPDATE monthly_reports SET review_state = 'changes_requested', state = 'review',
          accounting_reviewed_by = NULL, accounting_reviewed_name = NULL,
          accounting_reviewed_at = NULL, pm_reviewed_by = NULL,
          pm_reviewed_name = NULL, pm_reviewed_at = NULL, finalised_at = NULL
        WHERE id = ${id}`;
      return { final: false };
    }

    if (type === "ap_invoice") {
      if (lane === "accounting") await tx`
        UPDATE ap_invoices SET accounting_reviewed_by = ${user.id},
          accounting_reviewed_name = ${user.name}, accounting_reviewed_at = now()
        WHERE id = ${id}`;
      else await tx`
        UPDATE ap_invoices SET pm_reviewed_by = ${user.id},
          pm_reviewed_name = ${user.name}, pm_reviewed_at = now()
        WHERE id = ${id}`;
    } else {
      if (lane === "accounting") await tx`
        UPDATE monthly_reports SET accounting_reviewed_by = ${user.id},
          accounting_reviewed_name = ${user.name}, accounting_reviewed_at = now()
        WHERE id = ${id}`;
      else await tx`
        UPDATE monthly_reports SET pm_reviewed_by = ${user.id},
          pm_reviewed_name = ${user.name}, pm_reviewed_at = now()
        WHERE id = ${id}`;
    }

    const updated = await getEntity(tx, type, id, true);
    const complete = !!updated.accounting_reviewed_by && !!updated.pm_reviewed_by;
    if (complete && updated.accounting_reviewed_by === updated.pm_reviewed_by)
      return { error: "TWO_DIFFERENT_REVIEWERS_REQUIRED" };

    if (type === "ap_invoice" && complete && updated.state === "draft") {
      const period = String(updated.invoice_date).slice(0, 7);
      const [periodRow] = await tx`SELECT state FROM accounting_periods WHERE period = ${period}`;
      if (periodRow?.state === "closed") return { error: "ACCOUNTING_PERIOD_CLOSED" };
      const lines = await tx`SELECT * FROM ap_invoice_lines WHERE invoice_id = ${id} ORDER BY line_no`;
      const entryId = uid("je_");
      const [{ next_no }] = await tx`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_no FROM journal_entries`;
      await tx`INSERT INTO journal_entries (id, entry_no, entry_date, period, building_code,
        source, source_id, memo, state, created_by)
        VALUES (${entryId}, ${next_no}, ${updated.invoice_date}, ${period},
          ${updated.building_code}, 'ap_invoice', ${id}, ${`AP ${updated.invoice_no}`},
          'posted', ${user.id})`;
      let lineNo = 1;
      for (const line of lines) await tx`
        INSERT INTO journal_lines (id, entry_id, line_no, gl_code, debit, credit,
          building_code, unit_number, vendor_id, memo)
        VALUES (${uid("jl_")}, ${entryId}, ${lineNo++}, ${line.gl_code}, ${line.amount}, 0,
          ${line.building_code}, ${line.unit_number}, ${updated.vendor_id}, ${line.description})`;
      if (Number(updated.gst) > 0) await tx`
        INSERT INTO journal_lines (id, entry_id, line_no, gl_code, debit, credit,
          building_code, unit_number, vendor_id, memo)
        VALUES (${uid("jl_")}, ${entryId}, ${lineNo++}, '1210', ${updated.gst}, 0,
          ${updated.building_code}, ${updated.unit_number}, ${updated.vendor_id}, 'GST input tax credit')`;
      await tx`INSERT INTO journal_lines (id, entry_id, line_no, gl_code, debit, credit,
        building_code, unit_number, vendor_id, memo)
        VALUES (${uid("jl_")}, ${entryId}, ${lineNo}, '2010', 0, ${updated.total},
          ${updated.building_code}, ${updated.unit_number}, ${updated.vendor_id}, ${updated.invoice_no})`;
      await tx`UPDATE ap_invoices SET state = 'approved', entry_id = ${entryId},
        approved_by = accounting_reviewed_by, approved_at = now(), review_state = 'approved',
        finalised_at = now() WHERE id = ${id}`;
    } else if (type === "ap_invoice") {
      await tx`UPDATE ap_invoices SET review_state = ${complete ? "approved" : "awaiting_other"},
        finalised_at = CASE WHEN ${complete} THEN now() ELSE NULL END WHERE id = ${id}`;
    } else {
      await tx`UPDATE monthly_reports SET review_state = ${complete ? "approved" : "awaiting_other"},
        state = ${complete ? "final" : "review"},
        approved_by = CASE WHEN ${complete} THEN accounting_reviewed_by ELSE approved_by END,
        approved_at = CASE WHEN ${complete} THEN now() ELSE approved_at END,
        finalised_at = CASE WHEN ${complete} THEN now() ELSE NULL END WHERE id = ${id}`;
    }
    return { final: complete };
  });

  if (!outcome) return c.json({ code: "NOT_FOUND" }, 404);
  if (outcome.error) return c.json({ code: outcome.error }, 409);
  await audit(c, { action: `accounting_document.${body.decision}`, entityType: type,
    entityId: id, after: { lane, final: outcome.final, note: body.note || null } });
  const document = type === "ap_invoice"
    ? await hydrateInvoice(sql, id) : await hydrateReport(sql, id);
  return c.json({ document });
});

r.get("/accounting/files/:id", require_("accounting.view"), async (c) => {
  const sql = c.get("db");
  const [file] = await sql`SELECT * FROM accounting_document_files WHERE id = ${c.req.param("id")}`;
  if (!file) return c.json({ code: "NOT_FOUND" }, 404);
  const entity = await getEntity(sql, file.entity_type, file.entity_id);
  if (!entity) return c.json({ code: "NOT_FOUND" }, 404);
  const download = c.req.query("download") === "1";
  const user = c.get("user");
  if (download && (!file.is_current || entity.review_state !== "approved" ||
      !["property_manager", "admin"].includes(user.role)))
    return c.json({ code: "FINAL_PM_DOWNLOAD_NOT_AVAILABLE" }, 403);
  const object = await c.env.FILES?.get(file.storage_key);
  if (!object) return c.json({ code: "FILE_NOT_FOUND" }, 404);
  const disposition = download ? "attachment" : "inline";
  return new Response(object.body, { headers: {
    "Content-Type": file.mime_type,
    "Content-Length": String(file.size_bytes),
    "Content-Disposition": `${disposition}; filename="${safeFilename(file.filename, "document")}"`,
    "ETag": file.sha256,
    "Cache-Control": "private, no-store",
  } });
});

r.patch("/accounting/reports/:id", require_("accounting.reports"), async (c) => {
  const user = c.get("user");
  if (!["accounting", "admin", "property_manager"].includes(user.role))
    return c.json({ code: "ACCOUNTING_REPORT_GENERATION_REQUIRED" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const [report] = await sql`
    UPDATE monthly_reports SET narrative = ${body.narrative ?? null},
      model = ${body.model ?? null}, state = 'review'
    WHERE id = ${c.req.param("id")} RETURNING *`;
  if (!report) return c.json({ code: "NOT_FOUND" }, 404);
  const bytes = await reportPdf(report);
  await replaceFile(c, "monthly_report", report.id, {
    bytes, filename: `Management-Report-${report.period}-${report.building_code}.pdf`,
    mimeType: "application/pdf", source: "generated",
  });
  await audit(c, { action: "monthly_report.commentary.update", entityType: "monthly_report",
    entityId: report.id, after: { has_narrative: !!body.narrative, model: body.model ?? null } });
  return c.json({ report: await hydrateReport(sql, report.id) });
});

r.post("/accounting/reports/batch", require_("accounting.reports"), async (c) => {
  const user = c.get("user");
  if (!["accounting", "admin", "property_manager"].includes(user.role))
    return c.json({ code: "ACCOUNTING_REPORT_GENERATION_REQUIRED" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const input = Array.isArray(body.reports) ? body.reports.slice(0, 10) : [];
  if (!input.length) return c.json({ code: "REPORTS_REQUIRED" }, 400);
  const sql = c.get("db");
  const reports = [];
  for (const item of input) {
    if (!/^\d{4}-\d{2}$/.test(item.period ?? "") || !item.building_code || !item.figures || !item.method)
      return c.json({ code: "REPORT_FIELDS_REQUIRED" }, 400);
    const [report] = await sql`
      INSERT INTO monthly_reports (id, period, building_code, figures, method, narrative,
        model, state, review_state)
      VALUES (${uid("mr_")}, ${item.period}, ${item.building_code},
        ${JSON.stringify(item.figures)}, ${item.method}, ${item.narrative || null},
        ${item.model || null}, 'review', 'pending')
      ON CONFLICT (period, building_code) DO UPDATE SET
        figures = EXCLUDED.figures, method = EXCLUDED.method,
        narrative = EXCLUDED.narrative, model = EXCLUDED.model, state = 'review'
      RETURNING *`;
    const bytes = await reportPdf(report);
    await replaceFile(c, "monthly_report", report.id, {
      bytes, filename: `Management-Report-${report.period}-${report.building_code}.pdf`,
      mimeType: "application/pdf", source: "generated",
    });
    reports.push(await hydrateReport(sql, report.id));
  }
  await audit(c, { action: "monthly_reports.generate", entityType: "monthly_report",
    entityId: input[0].period, after: { buildings: reports.map((x) => x.building_code) } });
  return c.json({ reports }, 201);
});

export default r;
