import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { db, uid, nowISO, hashPassword, verifyPassword, randToken, sha256,
         passwordIssues, fileHash, UPLOAD_DIR, cents } from "../db.js";
import { audit, notify } from "../rbac.js";
import { screen, upsertContact, normEmail, normPhone } from "../screening.js";
import { queue, requestConfirmation } from "../outbox.js";

const r = Router();

/* ============================================================
   Tenant site: public bookings and applications, and the portal
   for people who have moved in.

   Tenant accounts are a separate table from staff users. A tenant
   is not a member of staff with fewer permissions — keeping them
   apart means one mistake in a role check cannot expose the
   console.
   ============================================================ */

const SESSION_HOURS = 24 * 14;   // a tenant signs in rarely; a short session is just friction
const LOCK_AFTER = 5, LOCK_MIN = 15;
const today = () => new Date().toISOString().slice(0, 10);
const ref = (p) => p + Date.now().toString(36).toUpperCase().slice(-6);

const publicLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { code: "TOO_MANY_REQUESTS" } });

/* ================= Public: what is available ================= */

r.get("/public/availability", (req, res) => {
  const units = db.prepare(`
    SELECT u.unit_type_code, t.bedroom_label_en, t.bedroom_label_zh, t.area_sqft,
           t.balcony_sqft,
           SUM(CASE WHEN u.status='available' THEN 1 ELSE 0 END) available,
           MIN(CASE WHEN u.status='available' THEN u.available_from END) earliest,
           COALESCE(MIN(r.base_rent), 0) rent
    FROM units u
    JOIN unit_types t ON t.code = u.unit_type_code
    LEFT JOIN pricing_profiles p ON p.effective_from <= date('now')
      AND (p.effective_to IS NULL OR p.effective_to >= date('now'))
    LEFT JOIN unit_type_rents r ON r.pricing_profile_id = p.id
      AND r.unit_type_code = u.unit_type_code
    GROUP BY u.unit_type_code ORDER BY t.area_sqft
  `).all();

  const pools = db.prepare("SELECT code, label_en, label_zh, total_stalls FROM parking_pools").all();
  const assigned = db.prepare(`SELECT pool_code, COUNT(*) n FROM parking_allocations
    WHERE status='assigned' GROUP BY pool_code`).all();
  const byPool = Object.fromEntries(assigned.map((a) => [a.pool_code, a.n]));
  const stalls = pools.reduce((acc, p) => ({
    total: acc.total + p.total_stalls,
    free: acc.free + (p.total_stalls - (byPool[p.code] ?? 0)) }), { total: 0, free: 0 });
  const waiting = db.prepare(`SELECT COUNT(*) n FROM parking_allocations
    WHERE status='waiting'`).get().n;

  const fees = db.prepare(`SELECT f.* FROM fee_settings f
    JOIN pricing_profiles p ON p.id = f.pricing_profile_id
    WHERE p.effective_from <= date('now') AND (p.effective_to IS NULL OR p.effective_to >= date('now'))
    ORDER BY p.effective_from DESC LIMIT 1`).get();

  res.json({
    // Mirrored layouts are the same suite reversed. Listing them separately
    // shows a prospective tenant two identical options.
    types: units.map((u) => ({ ...u, code: u.unit_type_code.replace(" (M)", "") })),
    // Parking is short by design of the building, not by policy. Saying so on
    // the public page costs a few enquiries and saves every one of those
    // tenants a bad surprise after signing.
    parking: { ...stalls, waiting },
    fees: fees ? { pet_limit: fees.pet_limit, utilities: fees.utilities_included,
                   parking_underground: fees.parking_underground,
                   parking_surface: fees.parking_surface, storage: fees.storage_fee } : null,
  });
});

/* ================= Public: booking a viewing ================= */

const SLOT_MIN = 30, DAY_START = 10, DAY_END = 18;
const NOTICE_HOURS = 24, LEAD_HOURS = 3, HORIZON_DAYS = 14;

/** Real availability, not a guess. A slot is offered only if nobody is
 *  already booked into it, and an occupied unit needs 24 hours' notice
 *  before anyone can view it — so those slots are simply not offered
 *  rather than offered and then cancelled. */
r.get("/public/slots", (req, res) => {
  const occupied = req.query.unit
    ? !!db.prepare(`SELECT 1 FROM moveouts WHERE unit_number=? AND state='open'
        AND vacated_at IS NULL`).get(req.query.unit)
    : !!req.query.unit_type;

  const earliest = Date.now() + (occupied ? NOTICE_HOURS : LEAD_HOURS) * 3600e3;
  const booked = db.prepare(`SELECT starts_at, duration_min FROM events
    WHERE state='booked' AND blocking=1 AND datetime(starts_at) >= datetime('now')`).all();
  const holidays = new Set(db.prepare(`SELECT holiday_date FROM holidays
    WHERE is_observed=1`).all().map((h) => h.holiday_date));

  const days = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    if (dow === 0 || holidays.has(iso)) continue;
    const endH = dow === 6 ? 16 : DAY_END;

    const slots = [];
    for (let h = DAY_START; h < endH; h++) {
      for (const m of [0, SLOT_MIN]) {
        const at = new Date(d); at.setHours(h, m, 0, 0);
        if (at.getTime() < earliest) continue;
        const end = new Date(at.getTime() + SLOT_MIN * 60000);
        const taken = booked.some((b) => {
          const bs = new Date(b.starts_at);
          const be = new Date(bs.getTime() + (b.duration_min || 30) * 60000);
          return at < be && bs < end;
        });
        if (!taken) slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
    if (slots.length) days.push({ date: iso, slots });
  }

  res.json({ days, occupied, notice_hours: occupied ? NOTICE_HOURS : LEAD_HOURS });
});

r.post("/public/showings", publicLimit, (req, res) => {
  const { unit_type, unit_number, date, time, name, email, phone, notes, locale } = req.body ?? {};
  if (!date || !time || !name?.trim() || !email?.trim())
    return res.status(400).json({ code: "MISSING_BOOKING_FIELDS" });

  const startsAt = `${date}T${time}:00`;
  const clash = db.prepare(`SELECT 1 FROM events WHERE state='booked' AND blocking=1
    AND starts_at = ?`).get(startsAt);
  if (clash) return res.status(409).json({ code: "SLOT_TAKEN" });

  const reference = ref("V");
  const out = db.transaction(() => {
    const contactId = upsertContact({ full_name: name, email, phone, locale });

    // A booking is a lead. Creating one here rather than later means the
    // pipeline shows people who booked and never turned up, which is the
    // number worth knowing.
    const existing = db.prepare(`SELECT id FROM leads WHERE email = ?`).get(String(email).trim());
    let leadId = existing?.id;
    if (!leadId) {
      leadId = uid("ld_");
      db.prepare(`INSERT INTO leads (id, contact_id, name, email, phone, source, stage,
        units, last_contact_at) VALUES (?,?,?,?,?,'Web form','booked',?,?)`)
        .run(leadId, contactId, name.trim(), email.trim(), phone ?? null,
             JSON.stringify(unit_number ? [unit_number] : []), nowISO());
    } else {
      db.prepare(`UPDATE leads SET stage='booked', last_contact_at=? WHERE id=?`)
        .run(nowISO(), leadId);
    }

    const eventId = uid("ev_");
    db.prepare(`INSERT INTO events (id, type, unit_number, contact_name, contact_info,
      starts_at, duration_min, blocking, state, created_via)
      VALUES (?,'showing',?,?,?,?,?,1,'booked','tenant')`)
      .run(eventId, unit_number ?? null, name.trim(), email.trim(), startsAt, SLOT_MIN);

    const id = uid("sr_");
    db.prepare(`INSERT INTO showing_requests (id, reference, unit_type, unit_number,
      requested_date, requested_time, name, email, phone, notes, locale, lead_id, event_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, reference, unit_type ?? null, unit_number ?? null, date, time,
           name.trim(), email.trim(), phone ?? null, notes ?? null, locale ?? "en",
           leadId, eventId);
    return { id, eventId, leadId };
  })();

  const zh = locale === "zh";
  const msg = queue({ kind: "showing_confirm", channel: "email", toEmail: email,
    toName: name, locale: locale ?? "en",
    subject: `Your viewing on ${date} at ${time} · ${reference}`,
    body: [
      `Thank you, ${name}. We have you booked for ${date} at ${time}${unit_number ? `, suite ${unit_number}` : ""}.`,
      `Your reference is ${reference}.`,
      "Reply to this message if you need a different time.",
      "",
      `謝謝你，${name}。已為你預約 ${date} ${time}${unit_number ? `，${unit_number}` : ""}。`,
      `參考編號 ${reference}。`,
      "需要改時間的話，回覆這封信即可。",
    ].join("\n"),
    refType: "showing_request", refId: out.id });

  requestConfirmation({ refType: "event", refId: out.eventId,
    question: `Does ${date} at ${time} still work for you?`,
    toEmail: email, outboxId: msg.id, expiresAt: startsAt });

  notify("building_manager", "showing", "SHOWING_BOOKED",
         { unit: unit_number ?? unit_type ?? "any", date, time, name },
         `/schedule?date=${date}`);

  res.status(201).json({ reference, id: out.id, date, time });
});

/* ================= Public: applying ================= */

/** Checked as the applicant types. A duplicate is caught at the email field
 *  rather than after six steps of form filling. */
r.post("/public/screen", publicLimit, (req, res) => {
  const { email, phone, full_name } = req.body ?? {};
  const outcome = screen({ email, phone, full_name });
  res.json({
    result: outcome.result, detail: outcome.detail,
    // A duplicate is refused. A resemblance is not — it goes to a person.
    blocking: outcome.result === "duplicate",
  });
});

r.post("/public/applications", publicLimit, (req, res) => {
  const { unit_type, unit_number, move_in, term, tenants, occupants, email, phone,
          wants_parking, wants_storage, pets, service_animal, monthly_total,
          upfront_total, fee_ack, consent, locale } = req.body ?? {};

  if (!email?.trim() || !tenants?.length)
    return res.status(400).json({ code: "MISSING_APPLICATION_FIELDS" });
  if (!consent) return res.status(400).json({ code: "CONSENT_REQUIRED" });
  if (!fee_ack) return res.status(400).json({ code: "FEE_ACK_REQUIRED" });

  const primary = tenants[0];
  const outcome = screen({ email, phone, full_name: primary });
  if (outcome.result === "duplicate")
    return res.status(409).json({ code: "ALREADY_APPLIED", detail: outcome.detail });

  const reference = ref("A");
  const out = db.transaction(() => {
    const contactId = upsertContact({ full_name: primary, email, phone, locale });
    const id = uid("app_");

    let screenId = null;
    if (outcome.result === "review") {
      screenId = uid("scr_");
      db.prepare(`INSERT INTO application_screens (id, application_id, email, phone,
        full_name, result, matched_type, matched_id, similarity, detail)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(screenId, id, normEmail(email), normPhone(phone), primary, "review",
             outcome.matched_type, outcome.matched_id, outcome.similarity, outcome.detail);
    }

    let leadId = db.prepare("SELECT id FROM leads WHERE email=?").get(email.trim())?.id;
    if (!leadId) {
      leadId = uid("ld_");
      db.prepare(`INSERT INTO leads (id, contact_id, name, email, phone, source, stage,
        move_in, units, last_contact_at) VALUES (?,?,?,?,?,'Web form','applied',?,?,?)`)
        .run(leadId, contactId, primary, email.trim(), phone ?? null, move_in ?? null,
             JSON.stringify(unit_number ? [unit_number] : []), nowISO());
    } else {
      db.prepare("UPDATE leads SET stage='applied', last_contact_at=? WHERE id=?")
        .run(nowISO(), leadId);
    }

    db.prepare(`INSERT INTO applications (id, reference, unit_type, unit_number, move_in,
      term, tenants, occupants, email, phone, wants_parking, wants_storage, pets,
      service_animal, monthly_total, upfront_total, fee_ack, consent, locale,
      lead_id, screen_id, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, reference, unit_type ?? null, unit_number ?? null, move_in ?? null,
           term ?? null, JSON.stringify(tenants), occupants ?? null, email.trim(),
           phone ?? null, wants_parking ? 1 : 0, wants_storage ? 1 : 0, pets ?? "none",
           service_animal ? 1 : 0, monthly_total ?? null, upfront_total ?? null,
           1, 1, locale ?? "en", leadId, screenId,
           outcome.result === "review" ? "screening" : "new");
    return { id, screenId };
  })();

  queue({ kind: "application_ack", channel: "email", toEmail: email, toName: primary,
    locale: locale ?? "en", subject: `Application received · ${reference}`,
    body: [
      `Thank you, ${primary}. We have your application, reference ${reference}.`,
      "Someone will be in touch within one business day.",
      "Nothing is committed yet — we confirm the suite and the costs before anything is signed.",
      "",
      `謝謝你，${primary}。已收到你的申請，編號 ${reference}。`,
      "同事會在一個工作天內跟你聯絡。",
      "目前還沒有任何約束，單位和費用我們都會再確認過才會進到簽約。",
    ].join("\n"),
    refType: "application", refId: out.id });

  if (out.screenId) {
    // Flagged, not refused. A person decides, and says why.
    notify("property_manager", "screening", "APPLICATION_NEEDS_REVIEW",
           { reference, detail: outcome.detail }, `/leads?screen=${out.screenId}`);
  } else {
    notify("property_manager", "application", "APPLICATION_RECEIVED",
           { reference, unit: unit_number ?? unit_type ?? "any" }, `/leads`);
  }

  res.status(201).json({ reference, id: out.id,
                         needs_review: outcome.result === "review" });
});

const upload = multer({ storage: multer.memoryStorage(),
                        limits: { fileSize: 20 * 1024 * 1024, files: 6 } });

r.post("/public/applications/:id/documents", publicLimit, upload.array("files", 6), (req, res) => {
  const app = db.prepare("SELECT * FROM applications WHERE id=?").get(req.params.id);
  if (!app) return res.status(404).json({ code: "APPLICATION_NOT_FOUND" });
  if (!req.files?.length) return res.status(400).json({ code: "NO_FILES" });

  const saved = [];
  for (const f of req.files) {
    const hash = fileHash(f.buffer);
    const safe = f.originalname.replace(/[^\w.\-]/g, "_").slice(-80);
    const dir = path.join(UPLOAD_DIR, "applications");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${app.reference}_${hash.slice(0, 8)}_${safe}`;
    fs.writeFileSync(path.join(dir, name), f.buffer);
    const id = uid("ad_");
    db.prepare(`INSERT INTO application_documents (id, application_id, filename, stored_path,
      mime_type, size_bytes, sha256) VALUES (?,?,?,?,?,?,?)`)
      .run(id, app.id, f.originalname, path.join("applications", name), f.mimetype,
           f.size, hash);
    saved.push({ id, filename: f.originalname });
  }
  res.status(201).json({ uploaded: saved.length, files: saved });
});

/* ================= Tenant portal ================= */

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20,
  standardHeaders: true, legacyHeaders: false, message: { code: "TOO_MANY_ATTEMPTS" } });

function tenantAuth(req, res, next) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = bearer || req.cookies?.baydo_tenant;
  if (!token) return res.status(401).json({ code: "NOT_AUTHENTICATED" });
  const row = db.prepare(`SELECT s.id sid, s.expires_at, a.* FROM tenant_sessions s
    JOIN tenant_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(sha256(token));
  if (!row) return res.status(401).json({ code: "SESSION_INVALID" });
  if (new Date(row.expires_at) < new Date()) return res.status(401).json({ code: "SESSION_EXPIRED" });
  if (!row.is_active) return res.status(403).json({ code: "ACCOUNT_DISABLED" });
  req.tenant = { id: row.id, email: row.email, name: row.full_name,
                 unit: row.unit_number, leaseId: row.lease_id, locale: row.locale,
                 sessionId: row.sid };
  next();
}

r.post("/tenant/login", loginLimit, (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ code: "MISSING_CREDENTIALS" });
  const a = db.prepare("SELECT * FROM tenant_accounts WHERE email = ?").get(String(email).trim());

  if (a?.locked_until && new Date(a.locked_until) > new Date())
    return res.status(423).json({ code: "ACCOUNT_LOCKED", locked_until: a.locked_until });

  const ok = a && a.is_active && a.password_hash && await verifyPassword(password, a);
  if (!ok) {
    if (a) {
      const n = a.failed_attempts + 1;
      db.prepare("UPDATE tenant_accounts SET failed_attempts=?, locked_until=? WHERE id=?")
        .run(n, n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null, a.id);
    }
    // Same message either way, for the same reason as the staff login.
    return res.status(401).json({ code: "INVALID_CREDENTIALS" });
  }

  const token = randToken();
  db.prepare(`INSERT INTO tenant_sessions (id, account_id, token_hash, expires_at)
    VALUES (?,?,?,?)`).run(uid("ts_"), a.id, sha256(token),
      new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString());
  db.prepare("UPDATE tenant_accounts SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?")
    .run(nowISO(), a.id);

  res.json({ token, tenant: { name: a.full_name, email: a.email, unit: a.unit_number,
                              locale: a.locale } });
});

r.post("/tenant/forgot", loginLimit, (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const a = db.prepare("SELECT * FROM tenant_accounts WHERE email=? AND is_active=1").get(email);
  if (a) {
    const raw = randToken();
    db.prepare(`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
      VALUES (?,?,?,?)`).run(uid("prt_"), a.id, sha256(raw),
        new Date(Date.now() + 30 * 60000).toISOString());
    const link = `${process.env.PUBLIC_TENANT_URL || "http://localhost:8081"}/portal/reset?token=${raw}`;
    queue({ kind: "password_reset", channel: "email", toEmail: a.email, toName: a.full_name,
      subject: "Reset your tenant portal password",
      body: [`Hello ${a.full_name},`, "",
        "Open this link within 30 minutes to set a new password:", "", link, "",
        "If that was not you, nothing has changed.",
      ].join("\n"), refType: "tenant_account", refId: a.id });
  }
  // Identical response whether or not the account exists.
  res.json({ ok: true, code: "RESET_SENT_IF_EXISTS" });
});

r.get("/tenant/me", tenantAuth, (req, res) => {
  const lease = req.tenant.leaseId
    ? db.prepare("SELECT * FROM leases WHERE id=?").get(req.tenant.leaseId) : null;
  const parking = db.prepare(`SELECT pa.*, pp.label_en, pp.label_zh FROM parking_allocations pa
    JOIN parking_pools pp ON pp.code = pa.pool_code
    WHERE pa.unit_number=? AND pa.status<>'released'`).get(req.tenant.unit);
  let waitlistPosition = null;
  if (parking?.status === "waiting") {
    waitlistPosition = db.prepare(`SELECT COUNT(*) n FROM parking_allocations
      WHERE pool_code=? AND status='waiting' AND requested_at <= ?`)
      .get(parking.pool_code, parking.requested_at).n;
  }
  const charges = db.prepare(`SELECT * FROM ar_charges WHERE unit_number=?
    AND state IN ('open','partial') ORDER BY due_date`).all(req.tenant.unit);

  res.json({
    tenant: req.tenant,
    lease: lease ? { start: lease.start_date, end: lease.end_date, term: lease.term_type,
                     rent: lease.rent } : null,
    parking: parking ? { status: parking.status, label: parking.label_en,
                         waitlist_position: waitlistPosition } : null,
    balance: cents(charges.reduce((t, c) => t + (c.amount - c.paid_amount), 0)),
    charges,
  });
});

r.get("/tenant/notices", tenantAuth, (req, res) => {
  res.json({ notices: db.prepare(`SELECT id, purpose, entry_date, window_from, window_to,
    body, sent_at FROM entry_notices WHERE unit_number=? AND state='sent'
    ORDER BY entry_date DESC LIMIT 50`).all(req.tenant.unit) });
});

r.get("/tenant/repairs", tenantAuth, (req, res) => {
  res.json({ repairs: db.prepare(`SELECT tr.*, m.state ticket_state, m.scheduled_at, m.vendor
    FROM tenant_repairs tr LEFT JOIN maintenance m ON m.id = tr.ticket_id
    WHERE tr.unit_number=? ORDER BY tr.created_at DESC`).all(req.tenant.unit) });
});

/** Reporting a repair creates the ticket directly. A form that queues a
 *  request for somebody to retype is a step where things get lost. */
r.post("/tenant/repairs", tenantAuth, (req, res) => {
  const { what, where_in_unit, urgent, category } = req.body ?? {};
  if (!what?.trim()) return res.status(400).json({ code: "DESCRIPTION_REQUIRED" });

  const out = db.transaction(() => {
    const ticketId = uid("mt_");
    db.prepare(`INSERT INTO maintenance (id, unit_number, tenant_name, tenant_phone,
      category, priority, description, rush) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ticketId, req.tenant.unit, req.tenant.name, null, category ?? "other",
           urgent ? "emergency" : "normal",
           `${what.trim()}${where_in_unit ? ` (${where_in_unit})` : ""}`, 0);
    const id = uid("tr_");
    db.prepare(`INSERT INTO tenant_repairs (id, account_id, unit_number, what,
      where_in_unit, urgent, ticket_id) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.tenant.id, req.tenant.unit, what.trim(), where_in_unit ?? null,
           urgent ? 1 : 0, ticketId);
    return { id, ticketId };
  })();

  // Urgent goes straight through. A leak sitting behind three other tickets
  // because a form was polite about it is the failure worth avoiding.
  notify("building_manager", urgent ? "emergency" : "maintenance",
         urgent ? "URGENT_REPAIR_REPORTED" : "REPAIR_REPORTED",
         { unit: req.tenant.unit, what: what.trim().slice(0, 120) },
         `/site?ticket=${out.ticketId}`);

  res.status(201).json({ id: out.id, ticket_id: out.ticketId, urgent: !!urgent });
});

r.post("/tenant/logout", tenantAuth, (req, res) => {
  db.prepare("UPDATE tenant_sessions SET revoked_at=? WHERE id=?").run(nowISO(), req.tenant.sessionId);
  res.json({ ok: true });
});

export default r;
