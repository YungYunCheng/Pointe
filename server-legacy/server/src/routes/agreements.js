import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { db, uid, nowISO, fileHash, UPLOAD_DIR } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { queue } from "../outbox.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Agreement library

   The system does not produce an agreement. Admin uploads the file
   a lawyer approved, and that file is what reaches the tenant, byte
   for byte. Nothing merges values into it, reflows it or generates
   a version of it.

   The reason is narrow and worth stating: a generated clause can be
   void, and it reads exactly as convincingly as a valid one. The
   only way to be sure the tenant signed what counsel approved is for
   those to be the same file.

   What the system tracks is which version is current, who approved
   it, and which version went to which tenant. That is the question
   asked in a dispute, and it is the one a generated document cannot
   answer.
   ============================================================ */

const AGREEMENT_DIR = "agreements";
const MAX_MB = 25;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // A signed agreement is a fixed document. Accepting a spreadsheet or an
    // archive here would mean accepting something that is not one.
    const ok = ["application/pdf",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
               .includes(file.mimetype);
    cb(ok ? null : Object.assign(new Error("UNSUPPORTED_FILE_TYPE"), { status: 400 }), ok);
  },
});

const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

/* ---------- Library ---------- */

/** Everyone with a session sees the library. What differs is what comes with
 *  it: Admin sees every version including drafts, everyone else sees only
 *  what has been approved, because that is the only thing they may use. */
r.get("/agreements", require_("units.view"), (req, res) => {
  const isAdmin = req.user.perms.has("templates.manage");
  const agreements = db.prepare(`SELECT * FROM agreements WHERE is_active = 1
    ORDER BY sort_order, name_en`).all();
  const versions = db.prepare(`SELECT * FROM agreement_versions
    ${isAdmin ? "" : "WHERE state = 'approved'"} ORDER BY uploaded_at DESC`).all();

  res.json({
    agreements: agreements.map((a) => {
      const mine = versions.filter((v) => v.agreement_id === a.id);
      const current = mine.find((v) => v.state === "approved") ?? null;
      return {
        ...a,
        required_for: parse(a.required_for, []),
        current_version: current,
        versions: isAdmin ? mine : mine.filter((v) => v.state === "approved"),
        // The useful state for a Property Manager is not the file's state, it
        // is whether there is anything here they can send.
        usable: !!current,
      };
    }),
    can_upload: isAdmin,
  });
});

r.post("/agreements", require_("templates.manage"), (req, res) => {
  const { code, name_en, name_zh, description, required_for, sort_order } = req.body ?? {};
  if (!code?.trim() || !name_en?.trim())
    return res.status(400).json({ code: "MISSING_AGREEMENT_FIELDS" });
  if (db.prepare("SELECT 1 FROM agreements WHERE code = ?").get(code.trim()))
    return res.status(409).json({ code: "AGREEMENT_EXISTS" });

  const id = uid("ag_");
  db.prepare(`INSERT INTO agreements (id, code, name_en, name_zh, description,
    required_for, sort_order) VALUES (?,?,?,?,?,?,?)`)
    .run(id, code.trim(), name_en.trim(), name_zh ?? name_en, description ?? null,
         JSON.stringify(required_for ?? []), sort_order ?? 100);
  audit(req, { action: "agreement.create", entityType: "agreement", entityId: id,
               after: { code, name_en } });
  res.status(201).json({ id });
});

/* ---------- Upload ---------- */

/** Admin only. Each upload is a new version — nothing is replaced in place,
 *  because the file somebody signed in March has to still be retrievable in
 *  March's form. */
r.post("/agreements/:id/versions", require_("templates.manage"),
       upload.single("file"), (req, res) => {
  const a = db.prepare("SELECT * FROM agreements WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ code: "AGREEMENT_NOT_FOUND" });
  if (!req.file) return res.status(400).json({ code: "FILE_REQUIRED" });

  const { version_label, effective_from, approval_note } = req.body ?? {};
  const label = version_label?.trim() || new Date().toISOString().slice(0, 10);
  if (db.prepare(`SELECT 1 FROM agreement_versions WHERE agreement_id=? AND version_label=?`)
        .get(a.id, label))
    return res.status(409).json({ code: "VERSION_LABEL_EXISTS", label });

  const sha = fileHash(req.file.buffer);

  // The same file uploaded twice under two labels is a filing mistake, and it
  // means two "versions" that are actually one.
  const dup = db.prepare(`SELECT version_label FROM agreement_versions
    WHERE agreement_id=? AND sha256=?`).get(a.id, sha);
  if (dup) return res.status(409).json({ code: "IDENTICAL_FILE_EXISTS",
                                          existing_label: dup.version_label });

  const dir = path.join(UPLOAD_DIR, AGREEMENT_DIR, a.code);
  fs.mkdirSync(dir, { recursive: true });
  const safe = req.file.originalname.replace(/[^\w.\-]/g, "_").slice(-80);
  const stored = path.join(AGREEMENT_DIR, a.code, `${sha.slice(0, 12)}_${safe}`);
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.file.buffer);

  const id = uid("av_");
  db.prepare(`INSERT INTO agreement_versions (id, agreement_id, version_label, filename,
    stored_path, mime_type, size_bytes, sha256, effective_from, approval_note,
    uploaded_by, uploaded_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, a.id, label, req.file.originalname, stored, req.file.mimetype,
         req.file.size, sha, effective_from ?? null, approval_note ?? null,
         req.user.id, req.user.name);

  audit(req, { action: "agreement.upload", entityType: "agreement_version", entityId: id,
               after: { agreement: a.code, label, filename: req.file.originalname,
                        sha256: sha, size: req.file.size } });
  res.status(201).json({ id, version_label: label, sha256: sha, size: req.file.size,
                         state: "uploaded" });
});

/** Approving is the gate. Until a version is approved nobody can send it, and
 *  approving supersedes whatever was current — there is exactly one live
 *  version of each agreement at a time, which is what stops two tenants
 *  signing two different leases in the same week. */
r.post("/agreements/versions/:id/approve", require_("templates.manage"), (req, res) => {
  const v = db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).json({ code: "VERSION_NOT_FOUND" });
  if (v.state === "approved") return res.status(409).json({ code: "ALREADY_APPROVED" });
  if (v.state === "withdrawn") return res.status(409).json({ code: "VERSION_WITHDRAWN" });

  const note = req.body?.approval_note;
  const out = db.transaction(() => {
    const previous = db.prepare(`SELECT * FROM agreement_versions
      WHERE agreement_id=? AND state='approved'`).get(v.agreement_id);
    if (previous)
      db.prepare("UPDATE agreement_versions SET state='superseded' WHERE id=?").run(previous.id);
    db.prepare(`UPDATE agreement_versions SET state='approved', approved_by=?, approved_name=?,
      approved_at=?, approval_note=COALESCE(?,approval_note) WHERE id=?`)
      .run(req.user.id, req.user.name, nowISO(), note ?? null, v.id);
    return { superseded: previous?.version_label ?? null };
  })();

  audit(req, { action: "agreement.approve", entityType: "agreement_version", entityId: v.id,
               before: { state: v.state },
               after: { state: "approved", by: req.user.name, superseded: out.superseded } });
  notify("property_manager", "agreements", "AGREEMENT_VERSION_LIVE",
         { label: v.version_label }, "/documents");
  res.json({ ok: true, ...out });
});

/** Withdrawing pulls a version out of use without deleting it. Anything
 *  already signed against it stays valid and stays retrievable — the point is
 *  to stop it being sent again, not to pretend it never existed. */
r.post("/agreements/versions/:id/withdraw", require_("templates.manage"), (req, res) => {
  const reason = req.body?.reason;
  if (!reason?.trim()) return res.status(400).json({ code: "REASON_REQUIRED" });
  const v = db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).json({ code: "VERSION_NOT_FOUND" });

  const issued = db.prepare(`SELECT COUNT(*) n FROM agreement_issues
    WHERE version_id=? AND state IN ('sent','signed')`).get(v.id).n;

  db.prepare(`UPDATE agreement_versions SET state='withdrawn', withdrawn_reason=? WHERE id=?`)
    .run(reason.trim(), v.id);
  audit(req, { action: "agreement.withdraw", entityType: "agreement_version", entityId: v.id,
               before: { state: v.state }, after: { state: "withdrawn", reason: reason.trim(),
                                                     already_issued: issued } });
  res.json({ ok: true, already_issued: issued });
});

/* ---------- Download ---------- */

/** Serves the file exactly as uploaded. No rendering, no rewriting, no
 *  watermark — the bytes that come out are the bytes counsel approved, and
 *  the hash is on the response so that can be checked. */
r.get("/agreements/versions/:id/file", require_("units.view"), (req, res) => {
  const v = db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).json({ code: "VERSION_NOT_FOUND" });

  // Only Admin can pull a version that is not live. Everyone else gets the
  // current one, so a draft cannot reach a tenant by way of a stale link.
  if (v.state !== "approved" && !req.user.perms.has("templates.manage"))
    return res.status(403).json({ code: "VERSION_NOT_APPROVED", state: v.state });

  const full = path.join(UPLOAD_DIR, v.stored_path);
  if (!fs.existsSync(full)) return res.status(410).json({ code: "FILE_MISSING" });

  db.prepare(`INSERT INTO agreement_downloads (id, version_id, by_user, by_name, purpose)
    VALUES (?,?,?,?,?)`).run(uid("adl_"), v.id, req.user.id, req.user.name,
    req.query.purpose ?? null);

  res.setHeader("Content-Type", v.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${v.filename}"`);
  res.setHeader("X-Content-SHA256", v.sha256);
  fs.createReadStream(full).pipe(res);
});

/* ---------- Issuing ---------- */

/** Records that a version went to a tenant, and sends it. The file is
 *  untouched: the particulars are captured alongside rather than merged in,
 *  because merging means either rewriting the approved document or filling
 *  form fields it may not have. Capturing them at the moment of issue also
 *  means a later price change cannot rewrite what the tenant was told. */
r.post("/agreements/issue", require_("lease.sign"), (req, res) => {
  const { agreement_id, version_id, unit_number, tenant_name, tenant_email,
          tenant_phone, contact_id, lease_id, particulars } = req.body ?? {};
  if (!tenant_name?.trim()) return res.status(400).json({ code: "TENANT_NAME_REQUIRED" });

  const v = version_id
    ? db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(version_id)
    : db.prepare(`SELECT * FROM agreement_versions WHERE agreement_id=? AND state='approved'`)
        .get(agreement_id);
  if (!v) return res.status(404).json({ code: "NO_APPROVED_VERSION" });
  if (v.state !== "approved")
    return res.status(409).json({ code: "VERSION_NOT_APPROVED", state: v.state });

  const id = uid("ai_");
  db.prepare(`INSERT INTO agreement_issues (id, version_id, agreement_id, unit_number,
    contact_id, tenant_name, tenant_email, tenant_phone, lease_id, particulars,
    issued_by, issued_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, v.id, v.agreement_id, unit_number ?? null, contact_id ?? null,
         tenant_name.trim(), tenant_email ?? null, tenant_phone ?? null, lease_id ?? null,
         JSON.stringify(particulars ?? {}), req.user.id, req.user.name);

  audit(req, { action: "agreement.issue", entityType: "agreement_issue", entityId: id,
               after: { version: v.version_label, sha256: v.sha256, unit_number,
                        tenant: tenant_name } });
  res.status(201).json({ id, version_label: v.version_label, sha256: v.sha256,
                         filename: v.filename });
});

r.post("/agreements/issues/:id/send", require_("lease.sign"), (req, res) => {
  const i = db.prepare(`SELECT ai.*, av.version_label, av.filename, av.sha256,
    ag.name_en, ag.name_zh FROM agreement_issues ai
    JOIN agreement_versions av ON av.id = ai.version_id
    JOIN agreements ag ON ag.id = ai.agreement_id WHERE ai.id = ?`).get(req.params.id);
  if (!i) return res.status(404).json({ code: "ISSUE_NOT_FOUND" });
  if (!i.tenant_email) return res.status(400).json({ code: "NO_EMAIL" });
  if (i.state !== "prepared") return res.status(409).json({ code: "ALREADY_SENT",
                                                             state: i.state });

  const p = parse(i.particulars, {});
  const money = (n) => (n == null ? null
    : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));

  // The figures go in the message, not into the document. The tenant sees what
  // they were told alongside the agreement they are being asked to sign, and
  // both are recorded.
  const lines = [
    `Hello ${i.tenant_name},`, "",
    `Attached is the ${i.name_en} for ${i.unit_number ?? "your suite"}.`,
  ];
  if (p.rent) lines.push(`Rent: ${money(p.rent)} per month.`);
  if (p.deposit) lines.push(`Security deposit: ${money(p.deposit)}.`);
  if (p.start_date) lines.push(`Start date: ${p.start_date}.`);
  lines.push("", "Please read it in full before signing. Reply to this message with any question.",
             "", `你好 ${i.tenant_name}，`, "",
             `附件是 ${i.unit_number ?? "你的單位"} 的${i.name_zh}。`);
  if (p.rent) lines.push(`月租：${money(p.rent)}`);
  if (p.deposit) lines.push(`保證金：${money(p.deposit)}`);
  if (p.start_date) lines.push(`起租日：${p.start_date}`);
  lines.push("", "請完整閱讀後再簽署，有任何問題回覆這封信即可。");

  const msg = queue({
    kind: "agreement_send", channel: "email", toEmail: i.tenant_email, toName: i.tenant_name,
    subject: `${i.name_en} · ${i.unit_number ?? ""}`.trim(),
    body: lines.join("\n"), refType: "agreement_issue", refId: i.id, userId: req.user.id,
  });

  db.prepare("UPDATE agreement_issues SET state='sent', sent_at=?, outbox_id=? WHERE id=?")
    .run(nowISO(), msg.id, i.id);
  audit(req, { action: "agreement.send", entityType: "agreement_issue", entityId: i.id,
               after: { to: i.tenant_email, version: i.version_label, sha256: i.sha256 } });
  res.json({ ok: true, message: msg });
});

r.post("/agreements/issues/:id/signed", require_("lease.sign"), (req, res) => {
  const i = db.prepare("SELECT * FROM agreement_issues WHERE id=?").get(req.params.id);
  if (!i) return res.status(404).json({ code: "ISSUE_NOT_FOUND" });
  db.prepare(`UPDATE agreement_issues SET state='signed', signed_at=?, signed_note=? WHERE id=?`)
    .run(req.body?.signed_at ?? nowISO(), req.body?.note ?? null, i.id);
  audit(req, { action: "agreement.signed", entityType: "agreement_issue", entityId: i.id,
               after: { note: req.body?.note ?? null } });
  res.json({ ok: true });
});

r.get("/agreements/issues", require_("units.view"), (req, res) => {
  const { state, unit, limit = 200 } = req.query;
  let sql = `SELECT ai.*, av.version_label, av.filename, av.sha256, ag.code, ag.name_en
             FROM agreement_issues ai
             JOIN agreement_versions av ON av.id = ai.version_id
             JOIN agreements ag ON ag.id = ai.agreement_id WHERE 1=1`;
  const args = [];
  if (state) { sql += " AND ai.state = ?"; args.push(state); }
  if (unit) { sql += " AND ai.unit_number = ?"; args.push(unit); }
  sql += " ORDER BY ai.issued_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  res.json({ issues: db.prepare(sql).all(...args)
    .map((x) => ({ ...x, particulars: parse(x.particulars, {}) })) });
});

/** What is missing before this property can sign anybody. Worth its own
 *  endpoint: an empty library is easy not to notice until the day somebody
 *  needs a lease. */
r.get("/agreements/readiness", require_("units.view"), (req, res) => {
  const rows = db.prepare(`
    SELECT a.code, a.name_en, a.name_zh, a.sort_order,
      (SELECT COUNT(*) FROM agreement_versions v
        WHERE v.agreement_id = a.id AND v.state = 'approved') live,
      (SELECT COUNT(*) FROM agreement_versions v WHERE v.agreement_id = a.id) uploaded
    FROM agreements a WHERE a.is_active = 1 ORDER BY a.sort_order`).all();
  const missing = rows.filter((x) => x.live === 0);
  res.json({
    agreements: rows,
    ready: missing.length === 0,
    missing: missing.map((m) => m.name_en),
    // Without an approved lease nothing downstream can complete, however
    // finished the rest of the system looks.
    blocking: missing.some((m) => m.code === "lease"),
  });
});

export default r;
