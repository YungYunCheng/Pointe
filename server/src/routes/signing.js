import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { db, uid, nowISO } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { queue } from "../outbox.js";
import * as storage from "../storage.js";
import { inspect, finalise, recordEvent } from "../signing.js";

const r = Router();

/* ============================================================
   Electronic signature

   What makes this hold up is not the drawn mark. It is the trail:
   who signed, when, from where, what they were shown, and proof
   the document did not change afterwards.

   So the source is hashed before it goes out, the signed copy is
   hashed after, and every event in between is recorded. The
   certificate of completion carries all of it and is bound into
   the signed file, so nobody can forward the pages they like
   without it.

   Alberta's Electronic Transactions Act requires the parties to
   have consented to sign electronically. That consent is a recorded
   event, not an assumption.
   ============================================================ */

const EXPIRY_DAYS = 14;
const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const ref = () => "SIG-" + crypto.randomBytes(4).toString("hex").toUpperCase();

const signLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60,
  standardHeaders: true, legacyHeaders: false, message: { code: "TOO_MANY_REQUESTS" } });

/* ================= Public: the signing page ================= */
/*
   No session. The token identifies one party on one document.
   Asking a tenant to create an account before they can sign their
   own lease is friction with nothing behind it.
*/

function partyByToken(token) {
  return db.prepare(`SELECT p.*, r.id request_id, r.reference, r.state request_state,
    r.source_filename, r.source_key, r.source_sha256, r.expires_at, r.locale, r.message,
    r.unit_number, r.particulars, ag.name_en agreement_name, ag.name_zh agreement_name_zh,
    av.version_label
    FROM signature_parties p
    JOIN signature_requests r ON r.id = p.request_id
    JOIN agreements ag ON ag.id = r.agreement_id
    JOIN agreement_versions av ON av.id = r.version_id
    WHERE p.access_token = ?`).get(token);
}

/** Whose turn it is. Ordered signing exists because the landlord countersigns
 *  after the tenant, and a countersignature on a document the tenant has not
 *  signed yet means nothing. */
function isTheirTurn(party) {
  const ahead = db.prepare(`SELECT COUNT(*) n FROM signature_parties
    WHERE request_id = ? AND sign_order < ? AND signed_at IS NULL`)
    .get(party.request_id, party.sign_order).n;
  return ahead === 0;
}

r.get("/public/sign/:token", signLimit, async (req, res) => {
  const p = partyByToken(req.params.token);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });

  if (p.expires_at && p.expires_at < nowISO())
    return res.status(410).json({ code: "EXPIRED", expired_at: p.expires_at });
  if (["voided", "declined"].includes(p.request_state))
    return res.status(410).json({ code: p.request_state.toUpperCase() });

  if (!p.viewed_at) {
    db.prepare("UPDATE signature_parties SET viewed_at=? WHERE id=?").run(nowISO(), p.id);
    if (p.request_state === "sent")
      db.prepare("UPDATE signature_requests SET state='viewed' WHERE id=?").run(p.request_id);
    recordEvent(p.request_id, "opened", { partyId: p.id, actorName: p.full_name,
      ip: req.ip, userAgent: req.headers["user-agent"],
      detail: `Opened by ${p.full_name}` });
  }

  const fields = db.prepare(`SELECT id, kind, label, page, x, y, width, height, required, value
    FROM signature_fields WHERE party_id = ? ORDER BY page, y DESC`).all(p.id);
  const others = db.prepare(`SELECT full_name, role, sign_order, signed_at
    FROM signature_parties WHERE request_id = ? ORDER BY sign_order`).all(p.request_id);

  res.json({
    reference: p.reference,
    agreement: { name: p.agreement_name, name_zh: p.agreement_name_zh,
                 version: p.version_label, filename: p.source_filename },
    unit_number: p.unit_number,
    particulars: parse(p.particulars, {}),
    locale: p.locale,
    message: p.message,
    party: { name: p.full_name, role: p.role, consented: !!p.consented_at,
             signed: !!p.signed_at, order: p.sign_order },
    your_turn: isTheirTurn(p),
    waiting_on: others.filter((o) => o.sign_order < p.sign_order && !o.signed_at)
      .map((o) => o.full_name),
    parties: others,
    fields,
    expires_at: p.expires_at,
    // Shown on the page so the tenant can check the file they downloaded is
    // the file they were asked to sign.
    source_sha256: p.source_sha256,
  });
});

/** The document itself. Streamed from storage untouched — what they read is
 *  the file counsel approved. */
r.get("/public/sign/:token/document", signLimit, async (req, res) => {
  const p = partyByToken(req.params.token);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  if (p.expires_at && p.expires_at < nowISO()) return res.status(410).json({ code: "EXPIRED" });

  recordEvent(p.request_id, "document_downloaded", { partyId: p.id, ip: req.ip,
    actorName: p.full_name, sha256: p.source_sha256 });

  const ok = await storage.stream(p.source_key, res, {
    filename: p.source_filename, contentType: "application/pdf", sha256: p.source_sha256 });
  if (!ok) res.status(410).json({ code: "FILE_MISSING" });
});

/** Consent, recorded separately and before anything is signed. The Act asks
 *  whether the party agreed to sign electronically, and "they clicked sign so
 *  they must have" is not an answer. */
r.post("/public/sign/:token/consent", signLimit, (req, res) => {
  const p = partyByToken(req.params.token);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  if (p.consented_at) return res.json({ ok: true, already: true });
  if (!req.body?.agreed) return res.status(400).json({ code: "CONSENT_REQUIRED" });

  db.prepare(`UPDATE signature_parties SET consented_at=?, ip_address=?, user_agent=?
    WHERE id=?`).run(nowISO(), req.ip, String(req.headers["user-agent"] ?? "").slice(0, 300), p.id);
  recordEvent(p.request_id, "consented", { partyId: p.id, actorName: p.full_name,
    ip: req.ip, userAgent: req.headers["user-agent"],
    detail: `${p.full_name} agreed to sign electronically` });
  res.json({ ok: true });
});

r.post("/public/sign/:token", signLimit, async (req, res) => {
  const p = partyByToken(req.params.token);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  if (p.signed_at) return res.status(409).json({ code: "ALREADY_SIGNED" });
  if (p.expires_at && p.expires_at < nowISO()) return res.status(410).json({ code: "EXPIRED" });
  if (!p.consented_at) return res.status(409).json({ code: "CONSENT_FIRST" });
  if (!isTheirTurn(p)) return res.status(409).json({ code: "NOT_YOUR_TURN" });

  const { signature, signature_kind, fields } = req.body ?? {};
  if (!signature) return res.status(400).json({ code: "SIGNATURE_REQUIRED" });

  // Every required field, or the document goes out with a blank where a date
  // should be and somebody has to chase it.
  const required = db.prepare(`SELECT * FROM signature_fields
    WHERE party_id=? AND required=1`).all(p.id);
  const given = Object.fromEntries((fields ?? []).map((f) => [f.id, f.value]));
  const missing = required.filter((f) =>
    !["signature", "initials"].includes(f.kind) && !String(given[f.id] ?? f.value ?? "").trim());
  if (missing.length)
    return res.status(400).json({ code: "FIELDS_INCOMPLETE",
      fields: missing.map((f) => f.label || f.kind) });

  const now = nowISO();
  db.transaction(() => {
    db.prepare(`UPDATE signature_parties SET signed_at=?, signature_image=?,
      signature_kind=?, ip_address=?, user_agent=? WHERE id=?`)
      .run(now, signature, signature_kind ?? "drawn", req.ip,
           String(req.headers["user-agent"] ?? "").slice(0, 300), p.id);
    const up = db.prepare("UPDATE signature_fields SET value=?, filled_at=? WHERE id=?");
    for (const f of fields ?? []) if (f.id) up.run(f.value ?? null, now, f.id);
  })();

  recordEvent(p.request_id, "signed", { partyId: p.id, actorName: p.full_name,
    ip: req.ip, userAgent: req.headers["user-agent"], sha256: p.source_sha256,
    detail: `${p.full_name} signed (${signature_kind ?? "drawn"})` });

  const remaining = db.prepare(`SELECT COUNT(*) n FROM signature_parties
    WHERE request_id=? AND signed_at IS NULL`).get(p.request_id).n;

  if (remaining > 0) {
    db.prepare("UPDATE signature_requests SET state='signed' WHERE id=?").run(p.request_id);
    // Tell the next party it is their turn, rather than leaving them to
    // wonder whether the link still works.
    const next = db.prepare(`SELECT * FROM signature_parties WHERE request_id=?
      AND signed_at IS NULL ORDER BY sign_order LIMIT 1`).get(p.request_id);
    if (next?.email) sendInvite(p.request_id, next, "your_turn");
    return res.json({ ok: true, waiting_on: remaining });
  }

  // Everyone has signed. Build the signed file, the certificate, and send.
  try {
    const out = await completeRequest(p.request_id, req);
    res.json({ ok: true, completed: true, signed_sha256: out.signed_sha256 });
  } catch (e) {
    // The signature is recorded either way. A failure here is a distribution
    // problem, not a signing one, and losing the signature over it would be
    // the worse outcome.
    recordEvent(p.request_id, "completion_failed", { detail: e.message });
    res.status(500).json({ code: "COMPLETION_FAILED", detail: e.message,
      note: "Your signature was recorded. Our team has been notified." });
  }
});

r.post("/public/sign/:token/decline", signLimit, (req, res) => {
  const p = partyByToken(req.params.token);
  if (!p) return res.status(404).json({ code: "NOT_FOUND" });
  const reason = String(req.body?.reason ?? "").trim();

  db.prepare(`UPDATE signature_parties SET declined_at=?, decline_reason=? WHERE id=?`)
    .run(nowISO(), reason || null, p.id);
  db.prepare(`UPDATE signature_requests SET state='declined', declined_reason=? WHERE id=?`)
    .run(reason || null, p.request_id);
  recordEvent(p.request_id, "declined", { partyId: p.id, actorName: p.full_name,
    ip: req.ip, detail: reason || "No reason given" });

  // Declining is a normal outcome, not a failure. Somebody should hear about
  // it quickly, because it usually means a term needs discussing.
  notify("property_manager", "signing", "SIGNATURE_DECLINED",
         { reference: p.reference, party: p.full_name, reason: reason || "" },
         `/agreements?sig=${p.request_id}`);
  res.json({ ok: true });
});

/* ================= Completion ================= */

async function completeRequest(requestId, req) {
  const request = db.prepare(`SELECT r.*, ag.name_en agreement_name, av.version_label
    FROM signature_requests r
    JOIN agreements ag ON ag.id = r.agreement_id
    JOIN agreement_versions av ON av.id = r.version_id
    WHERE r.id = ?`).get(requestId);
  const parties = db.prepare(`SELECT * FROM signature_parties WHERE request_id=?
    ORDER BY sign_order`).all(requestId);
  const fields = db.prepare("SELECT * FROM signature_fields WHERE request_id=?").all(requestId);

  const out = await finalise(request, parties, fields);

  db.prepare(`UPDATE signature_requests SET state='completed', signed_key=?,
    certificate_key=?, signed_sha256=?, completed_at=? WHERE id=?`)
    .run(out.signed_key, out.certificate_key, out.signed_sha256, nowISO(), requestId);

  recordEvent(requestId, "completed", { sha256: out.signed_sha256,
    detail: "Signed document and certificate generated" });

  // The signed copy goes to everyone who signed it. A tenant who has to ask
  // for a copy of their own lease has been given a reason not to trust the
  // process.
  const link = `${process.env.PUBLIC_TENANT_URL || "http://localhost:8081"}/signed/${request.reference}`;
  for (const p of parties) {
    if (!p.email) continue;
    const zh = request.locale === "zh";
    const msg = queue({
      kind: "signed_copy", channel: "email", toEmail: p.email, toName: p.full_name,
      locale: request.locale,
      subject: zh ? `已簽署：${request.agreement_name}${request.unit_number ? ` · ${request.unit_number}` : ""}`
                  : `Signed: ${request.agreement_name}${request.unit_number ? ` · ${request.unit_number}` : ""}`,
      body: (zh ? [
        `${p.full_name} 你好，`, "",
        `${request.agreement_name} 已由雙方簽署完成，附件是完整的簽署版本，含完成證明書。`,
        `參考編號：${request.reference}`, "",
        `文件下載：${link}`, "",
        "證明書記載了每一位簽署人、簽署時間，以及文件的雜湊值。請妥善保存。",
        "有任何問題回覆這封信即可。",
      ] : [
        `Hello ${p.full_name},`, "",
        `${request.agreement_name} has been signed by all parties. Attached is the complete signed version with its certificate of completion.`,
        `Reference: ${request.reference}`, "",
        `Download: ${link}`, "",
        "The certificate records who signed, when, and the hash of the document. Keep it with your copy.",
        "Reply to this message with any question.",
      ]).join("\n"),
      refType: "signature_request", refId: requestId,
    });
    db.prepare("UPDATE signature_parties SET outbox_id=? WHERE id=?").run(msg.id, p.id);
  }

  // And back to the person who sent it out.
  notify("property_manager", "signing", "SIGNATURE_COMPLETED",
         { reference: request.reference, unit: request.unit_number ?? "",
           agreement: request.agreement_name },
         `/agreements?sig=${requestId}`);

  // The agreement issue moves with it, so the record of what went to whom
  // does not need updating by hand.
  if (request.issue_id)
    db.prepare(`UPDATE agreement_issues SET state='signed', signed_at=? WHERE id=?`)
      .run(nowISO(), request.issue_id);

  return out;
}

/* ================= Staff ================= */

r.use(authenticate);

r.get("/signatures", require_("units.view"), (req, res) => {
  const { state, unit, limit = 100 } = req.query;
  let sql = `SELECT r.*, ag.name_en agreement_name, av.version_label
             FROM signature_requests r
             JOIN agreements ag ON ag.id = r.agreement_id
             JOIN agreement_versions av ON av.id = r.version_id WHERE 1=1`;
  const args = [];
  if (state) { sql += " AND r.state = ?"; args.push(state); }
  if (unit) { sql += " AND r.unit_number = ?"; args.push(unit); }
  sql += " ORDER BY r.created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 100, 500));

  const rows = db.prepare(sql).all(...args);
  const parties = db.prepare(`SELECT id, request_id, role, full_name, email, sign_order,
    viewed_at, consented_at, signed_at, declined_at FROM signature_parties
    ORDER BY sign_order`).all();

  res.json({ requests: rows.map((x) => ({ ...x,
    particulars: parse(x.particulars, {}),
    parties: parties.filter((p) => p.request_id === x.id) })) });
});

r.get("/signatures/:id", require_("units.view"), (req, res) => {
  const rq = db.prepare(`SELECT r.*, ag.name_en agreement_name, av.version_label
    FROM signature_requests r JOIN agreements ag ON ag.id = r.agreement_id
    JOIN agreement_versions av ON av.id = r.version_id WHERE r.id = ?`).get(req.params.id);
  if (!rq) return res.status(404).json({ code: "NOT_FOUND" });
  res.json({
    request: { ...rq, particulars: parse(rq.particulars, {}) },
    parties: db.prepare("SELECT * FROM signature_parties WHERE request_id=? ORDER BY sign_order")
      .all(rq.id),
    fields: db.prepare("SELECT * FROM signature_fields WHERE request_id=? ORDER BY page, y DESC")
      .all(rq.id),
    events: db.prepare("SELECT * FROM signature_events WHERE request_id=? ORDER BY at").all(rq.id),
  });
});

/** Reads the page sizes so fields can be placed against real coordinates
 *  rather than guessed ones. */
r.get("/signatures/inspect/:versionId", require_("lease.sign"), async (req, res) => {
  const v = db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(req.params.versionId);
  if (!v) return res.status(404).json({ code: "VERSION_NOT_FOUND" });
  const buf = await storage.get(v.stored_path);
  if (!buf) return res.status(410).json({ code: "FILE_MISSING" });
  try {
    res.json({ filename: v.filename, sha256: v.sha256, ...(await inspect(buf)) });
  } catch (e) {
    res.status(400).json({ code: "NOT_A_PDF", detail: e.message });
  }
});

r.post("/signatures", require_("lease.sign"), async (req, res) => {
  const { version_id, issue_id, unit_number, lease_id, locale, message,
          parties = [], fields = [], particulars } = req.body ?? {};
  if (!version_id) return res.status(400).json({ code: "VERSION_REQUIRED" });
  if (!parties.length) return res.status(400).json({ code: "PARTIES_REQUIRED" });

  const v = db.prepare("SELECT * FROM agreement_versions WHERE id=?").get(version_id);
  if (!v) return res.status(404).json({ code: "VERSION_NOT_FOUND" });

  // Only an approved version can be sent for signature. Everything downstream
  // assumes the clause text was reviewed.
  if (v.state !== "approved")
    return res.status(409).json({ code: "VERSION_NOT_APPROVED", state: v.state });

  const buf = await storage.get(v.stored_path);
  if (!buf) return res.status(410).json({ code: "FILE_MISSING" });

  const id = uid("sr_");
  const reference = ref();
  const expires = new Date(Date.now() + EXPIRY_DAYS * 864e5).toISOString();

  db.transaction(() => {
    db.prepare(`INSERT INTO signature_requests (id, reference, issue_id, version_id,
      agreement_id, unit_number, lease_id, source_sha256, source_filename, source_key,
      particulars, locale, message, expires_at, created_by, created_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, reference, issue_id ?? null, v.id, v.agreement_id, unit_number ?? null,
           lease_id ?? null, v.sha256, v.filename, v.stored_path,
           JSON.stringify(particulars ?? {}), locale ?? "en", message ?? null,
           expires, req.user.id, req.user.name);

    const insP = db.prepare(`INSERT INTO signature_parties (id, request_id, role, full_name,
      email, phone, sign_order, access_token) VALUES (?,?,?,?,?,?,?,?)`);
    const insF = db.prepare(`INSERT INTO signature_fields (id, request_id, party_id, kind,
      label, page, x, y, width, height, required) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

    parties.forEach((p, i) => {
      const pid = uid("sp_");
      insP.run(pid, id, p.role ?? "tenant", p.full_name, p.email ?? null, p.phone ?? null,
               p.sign_order ?? i + 1, crypto.randomBytes(24).toString("base64url"));
      for (const f of fields.filter((x) => x.party_index === i)) {
        insF.run(uid("sf_"), id, pid, f.kind ?? "signature", f.label ?? null,
                 f.page ?? 1, f.x, f.y, f.width ?? 180, f.height ?? 44,
                 f.required === false ? 0 : 1);
      }
    });
  })();

  recordEvent(id, "created", { actorName: req.user.name, sha256: v.sha256,
    detail: `Prepared from ${v.version_label}` });
  audit(req, { action: "signature.create", entityType: "signature_request", entityId: id,
               after: { reference, version: v.version_label, parties: parties.length } });
  res.status(201).json({ id, reference, expires_at: expires });
});

function sendInvite(requestId, party, kind = "invite") {
  const rq = db.prepare(`SELECT r.*, ag.name_en, ag.name_zh FROM signature_requests r
    JOIN agreements ag ON ag.id = r.agreement_id WHERE r.id = ?`).get(requestId);
  if (!party.email) return null;

  const link = `${process.env.PUBLIC_TENANT_URL || "http://localhost:8081"}/sign/${party.access_token}`;
  const zh = rq.locale === "zh";
  const name = zh ? rq.name_zh : rq.name_en;

  const body = (zh ? [
    `${party.full_name} 你好，`, "",
    kind === "your_turn"
      ? `輪到你簽署${name}了${rq.unit_number ? `（${rq.unit_number}）` : ""}。`
      : `請簽署${name}${rq.unit_number ? `（${rq.unit_number}）` : ""}。`,
    rq.message ? `\n${rq.message}\n` : "",
    `簽署連結：${link}`, "",
    `連結於 ${String(rq.expires_at).slice(0, 10)} 失效。`,
    "簽署前請完整閱讀文件。有任何問題，先問清楚再簽。",
  ] : [
    `Hello ${party.full_name},`, "",
    kind === "your_turn"
      ? `It is your turn to sign the ${name}${rq.unit_number ? ` for ${rq.unit_number}` : ""}.`
      : `Please sign the ${name}${rq.unit_number ? ` for ${rq.unit_number}` : ""}.`,
    rq.message ? `\n${rq.message}\n` : "",
    `Sign here: ${link}`, "",
    `The link expires on ${String(rq.expires_at).slice(0, 10)}.`,
    "Please read the document in full before signing. If anything is unclear, ask before you sign rather than after.",
  ]).filter((x) => x !== "").join("\n");

  const msg = queue({ kind: "signature_invite", channel: "email", toEmail: party.email,
    toName: party.full_name, locale: rq.locale,
    subject: zh ? `請簽署：${name}` : `Please sign: ${name}`,
    body, refType: "signature_request", refId: requestId,
    expiresAt: rq.expires_at });

  db.prepare("UPDATE signature_parties SET outbox_id=? WHERE id=?").run(msg.id, party.id);
  return msg;
}

r.post("/signatures/:id/send", require_("lease.sign"), (req, res) => {
  const rq = db.prepare("SELECT * FROM signature_requests WHERE id=?").get(req.params.id);
  if (!rq) return res.status(404).json({ code: "NOT_FOUND" });
  if (rq.state !== "draft") return res.status(409).json({ code: "ALREADY_SENT", state: rq.state });

  // Only the first in line is invited. Sending to everyone at once means a
  // countersignature can arrive on a document the tenant has not signed.
  const first = db.prepare(`SELECT * FROM signature_parties WHERE request_id=?
    ORDER BY sign_order LIMIT 1`).get(rq.id);
  if (!first?.email) return res.status(400).json({ code: "NO_EMAIL" });

  const msg = sendInvite(rq.id, first);
  db.prepare("UPDATE signature_requests SET state='sent' WHERE id=?").run(rq.id);
  recordEvent(rq.id, "sent", { partyId: first.id, actorName: req.user.name,
    detail: `Invitation sent to ${first.email}` });
  audit(req, { action: "signature.send", entityType: "signature_request", entityId: rq.id,
               after: { to: first.email, reference: rq.reference } });
  res.json({ ok: true, message: msg });
});

r.post("/signatures/:id/remind", require_("lease.sign"), (req, res) => {
  const pending = db.prepare(`SELECT * FROM signature_parties WHERE request_id=?
    AND signed_at IS NULL ORDER BY sign_order LIMIT 1`).get(req.params.id);
  if (!pending) return res.status(409).json({ code: "NOTHING_PENDING" });
  if (pending.reminded_at &&
      Date.now() - new Date(pending.reminded_at).getTime() < 24 * 3600e3)
    return res.status(429).json({ code: "REMINDED_RECENTLY", at: pending.reminded_at });

  sendInvite(req.params.id, pending, "your_turn");
  db.prepare(`UPDATE signature_parties SET reminded_at=?, reminder_count=reminder_count+1
    WHERE id=?`).run(nowISO(), pending.id);
  recordEvent(req.params.id, "reminded", { partyId: pending.id, actorName: req.user.name });
  res.json({ ok: true });
});

/** Voiding stops a request without deleting it. Anything already signed under
 *  it stays retrievable — the point is to stop it completing, not to pretend
 *  it never happened. */
r.post("/signatures/:id/void", require_("lease.sign"), (req, res) => {
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) return res.status(400).json({ code: "REASON_REQUIRED" });
  const rq = db.prepare("SELECT * FROM signature_requests WHERE id=?").get(req.params.id);
  if (!rq) return res.status(404).json({ code: "NOT_FOUND" });
  if (rq.state === "completed") return res.status(409).json({ code: "ALREADY_COMPLETED" });

  db.prepare("UPDATE signature_requests SET state='voided', voided_reason=? WHERE id=?")
    .run(reason, rq.id);
  recordEvent(rq.id, "voided", { actorName: req.user.name, detail: reason });
  audit(req, { action: "signature.void", entityType: "signature_request", entityId: rq.id,
               after: { reason } });
  res.json({ ok: true });
});

/* ---------- Downloads ---------- */

r.get("/signatures/:id/signed", require_("units.view"), async (req, res) => {
  const rq = db.prepare("SELECT * FROM signature_requests WHERE id=?").get(req.params.id);
  if (!rq?.signed_key) return res.status(404).json({ code: "NOT_SIGNED_YET" });
  recordEvent(rq.id, "signed_copy_downloaded", { actorName: req.user.name, ip: req.ip });
  const ok = await storage.stream(rq.signed_key, res, {
    filename: `${rq.reference}-signed.pdf`, contentType: "application/pdf",
    sha256: rq.signed_sha256 });
  if (!ok) res.status(410).json({ code: "FILE_MISSING" });
});

r.get("/signatures/:id/certificate", require_("units.view"), async (req, res) => {
  const rq = db.prepare("SELECT * FROM signature_requests WHERE id=?").get(req.params.id);
  if (!rq?.certificate_key) return res.status(404).json({ code: "NO_CERTIFICATE" });
  const ok = await storage.stream(rq.certificate_key, res, {
    filename: `${rq.reference}-certificate.pdf`, contentType: "application/pdf" });
  if (!ok) res.status(410).json({ code: "FILE_MISSING" });
});

/** Public download of the completed copy, by reference. A tenant should be
 *  able to fetch their own lease without an account. */
r.get("/public/signed/:reference", signLimit, async (req, res) => {
  const rq = db.prepare(`SELECT * FROM signature_requests WHERE reference=?
    AND state='completed'`).get(req.params.reference);
  if (!rq?.signed_key) return res.status(404).json({ code: "NOT_FOUND" });
  recordEvent(rq.id, "copy_downloaded", { ip: req.ip, detail: "Public link" });
  const ok = await storage.stream(rq.signed_key, res, {
    filename: `${rq.reference}-signed.pdf`, contentType: "application/pdf",
    sha256: rq.signed_sha256 });
  if (!ok) res.status(410).json({ code: "FILE_MISSING" });
});

/** Checks a copy against what was signed. If somebody produces a lease and
 *  says it is the one, this is how you find out. */
r.post("/signatures/verify", require_("units.view"), (req, res) => {
  const { sha256 } = req.body ?? {};
  if (!sha256) return res.status(400).json({ code: "HASH_REQUIRED" });
  const match = db.prepare(`SELECT reference, unit_number, completed_at, signed_sha256
    FROM signature_requests WHERE signed_sha256 = ?`).get(sha256);
  res.json({ matches: !!match, document: match ?? null,
    detail: match ? "This is the signed document on file."
      : "No signed document on file has this hash. It is not a copy of anything signed here." });
});

export default r;
