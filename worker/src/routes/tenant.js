import { Hono } from "hono";
import { tenantUnit, mustBeTheirs, audit, uid } from "../lib/auth.js";
import { hashPassword, verifyPassword, randToken, sha256 } from "../lib/crypto.js";

/* ============================================================
   The tenant side

   Everything under /api/public/ is reachable by anyone with the
   URL. Everything under /api/tenant/ needs a tenant session.

   No route here takes a unit number from the caller. The unit
   comes from the session, and the middleware refuses a request
   that tries to pass one — reading it from the URL is how a tenant
   portal leaks, and it leaks quietly.
   ============================================================ */

const r = new Hono();

const SESSION_HOURS = 24 * 14;   // a tenant signs in rarely; a short one is friction
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const EDMONTON_TZ = "America/Edmonton";
const safeFilename = (value, fallback = "floorplan") => {
  const name = String(value ?? "").split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || fallback;
};
const floorplanKey = (code) => `floorplans/${safeFilename(code)}/current`;

const ymdInEdmonton = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const addCalendarDays = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Convert an Edmonton wall-clock time to an instant without trusting the
 * browser's timezone. Viewings are property-local even when somebody books
 * while travelling. Office hours never touch the DST changeover hour. */
const edmontonInstant = (ymd, clock) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !/^\d{2}:\d{2}$/.test(clock)) return null;
  const guessMs = Date.parse(`${ymd}T${clock}:00Z`);
  if (!Number.isFinite(guessMs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guessMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const shownAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"));
  return new Date(guessMs - (shownAsUtc - guessMs));
};

/* ---------- Public ---------- */

r.get("/public/availability", async (c) => {
  const sql = c.get("db");

  const types = await sql`
    SELECT replace(u.unit_type_code, ' (M)', '') AS unit_type_code,
           MIN(t.bedroom_label_en) AS bedroom_label_en,
           MIN(t.bedroom_label_zh) AS bedroom_label_zh, MIN(t.area_sqft) AS area_sqft,
           MIN(t.balcony_sqft) AS balcony_sqft,
           MAX(t.virtual_tour_url) AS virtual_tour_url,
           MAX(t.virtual_tour_provider) AS virtual_tour_provider,
           COUNT(*) FILTER (WHERE u.status = 'available')::int AS available,
           MIN(u.available_from) FILTER (WHERE u.status = 'available') AS earliest,
           COALESCE(MIN(r.base_rent), 0) AS rent
    FROM units u
    JOIN unit_types t ON t.code = u.unit_type_code
    LEFT JOIN pricing_profiles p
      ON p.effective_from <= CURRENT_DATE
     AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    LEFT JOIN unit_type_rents r
      ON r.pricing_profile_id = p.id AND r.unit_type_code = u.unit_type_code
    GROUP BY replace(u.unit_type_code, ' (M)', '')
    ORDER BY MIN(t.area_sqft)`;

  const [parking] = await sql`
    SELECT
      (SELECT SUM(total_stalls)::int FROM parking_pools) AS total,
      (SELECT SUM(total_stalls)::int FROM parking_pools) -
        (SELECT COUNT(*)::int FROM parking_allocations WHERE status = 'assigned')
        AS free,
      (SELECT COUNT(*)::int FROM parking_allocations WHERE status = 'waiting')
        AS waiting`;

  const [fees] = await sql`
    SELECT f.* FROM fee_settings f
    JOIN pricing_profiles p ON p.id = f.pricing_profile_id
    WHERE p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    ORDER BY p.effective_from DESC LIMIT 1`;

  return c.json({
    // Mirrored layouts fold together. The same suite reversed is not two
    // options, and listing it twice reads as padding once somebody notices.
    types: types.map((t) => ({ ...t, code: t.unit_type_code,
      floorplan_image_url: `/api/public/floorplan-images/${encodeURIComponent(t.unit_type_code)}` })),
    // Said out loud on the public page. 222 stalls against 330 units is
    // structural, and a tenant who finds out after signing has a reason to be
    // annoyed that one who was told does not.
    parking,
    fees: fees ?? null,
  });
});

r.get("/public/floorplan-images/:code", async (c) => {
  const code = decodeURIComponent(c.req.param("code"));
  if (!c.env.FILES) return c.json({ code: "FILE_STORAGE_NOT_CONFIGURED" }, 503);
  const object = await c.env.FILES.get(floorplanKey(code));
  if (!object) return c.json({ code: "FILE_NOT_FOUND" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType || "image/jpeg");
  headers.set("Cache-Control", "public, max-age=60");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Disposition",
    `inline; filename="${safeFilename(object.customMetadata?.filename, `${code}-floorplan`)}"`);
  return new Response(object.body, { headers });
});

/**
 * Real slots, from the schedule.
 *
 * An occupied suite needs 24 hours' notice before anyone can view it, so
 * those slots are not offered rather than offered and withdrawn. Offering a
 * time and taking it back is worse than never showing it.
 */
async function availableSlots(sql, unitType) {
  const [occupiedRow] = unitType
    ? await sql`SELECT EXISTS (
        SELECT 1 FROM units u JOIN moveouts m ON m.unit_number = u.unit_number
        WHERE u.unit_type_code = ${unitType} AND m.state = 'open'
          AND m.vacated_at IS NULL) AS occupied`
    : [{ occupied: false }];
  const occupied = occupiedRow.occupied;

  const noticeHours = occupied ? 24 : 3;
  const earliest = new Date(Date.now() + noticeHours * 3600e3);

  const booked = await sql`
    SELECT starts_at, duration_min FROM events
    WHERE state = 'booked' AND blocking
      AND starts_at >= now() AND starts_at < now() + INTERVAL '14 days'`;
  const holidays = await sql`
    SELECT holiday_date FROM holidays
    WHERE is_observed AND holiday_date >= CURRENT_DATE`;
  const holidaySet = new Set(holidays.map((h) => String(h.holiday_date).slice(0, 10)));

  const SLOT = 30, OPEN = 10, CLOSE = 18, SAT_CLOSE = 16;
  const days = [];
  const today = ymdInEdmonton();
  for (let i = 0; i < 14; i++) {
    const iso = addCalendarDays(today, i);
    const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (dow === 0 || holidaySet.has(iso)) continue;

    const slots = [];
    for (let h = OPEN; h < (dow === 6 ? SAT_CLOSE : CLOSE); h++) {
      for (const m of [0, SLOT]) {
        const at = edmontonInstant(iso,
          `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
        if (at < earliest) continue;
        const end = new Date(at.getTime() + SLOT * 60000);
        const taken = booked.some((b) => {
          const bs = new Date(b.starts_at);
          return at < new Date(bs.getTime() + (b.duration_min ?? 30) * 60000) && bs < end;
        });
        if (!taken) slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
    if (slots.length) days.push({ date: iso, slots });
  }

  return { days, occupied, notice_hours: noticeHours,
    note: occupied
      ? "This suite is occupied, so a viewing needs 24 hours' notice to the tenant."
      : null };
}

r.get("/public/slots", async (c) => {
  return c.json(await availableSlots(c.get("db"), c.req.query("unit_type")));
});

/* ---------- Portal ---------- */

r.post("/public/tenant/login", async (c) => {
  const sql = c.get("db");
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ code: "MISSING_CREDENTIALS" }, 400);

  const [a] = await sql`SELECT * FROM tenant_accounts
    WHERE lower(email) = ${String(email).trim().toLowerCase()}`;

  if (a?.locked_until && new Date(a.locked_until) > new Date())
    return c.json({ code: "ACCOUNT_LOCKED", locked_until: a.locked_until }, 423);

  let ok = false;
  try {
    ok = !!(a?.is_active && a.email_verified_at && a.password_hash &&
            await verifyPassword(password, a, sql));
  } catch (e) {
    if (e.code === "PASSWORD_NEEDS_RESET")
      return c.json({ code: "PASSWORD_NEEDS_RESET" }, 409);
    throw e;
  }

  if (!ok) {
    if (a) {
      await sql`UPDATE tenant_accounts
        SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER}
          THEN now() + (${LOCK_MINUTES} * INTERVAL '1 minute') ELSE locked_until END
        WHERE id = ${a.id}`;
    }
    // Same message whether or not the account exists, for the same reason as
    // the staff login: anything else turns this into an account checker.
    return c.json({ code: "INVALID_CREDENTIALS" }, 401);
  }

  const token = randToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  const hash = await sha256(token);

  // One transaction. Creating the session and clearing the failed count are
  // one act — a session that exists while the lock counter still says four
  // means the next mistyped password locks somebody who just signed in.
  await sql.begin(async (tx) => {
    await tx`INSERT INTO tenant_sessions (id, account_id, token_hash, expires_at)
      VALUES (${uid("ts_")}, ${a.id}, ${hash}, ${expires})`;
    await tx`UPDATE tenant_accounts SET failed_attempts = 0, locked_until = NULL,
      last_login_at = now() WHERE id = ${a.id}`;
  });

  c.header("Set-Cookie",
    `baydo_tenant_session=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${
      SESSION_HOURS * 3600}${c.env.ENVIRONMENT === "production" ? "; Secure" : ""}`);

  return c.json({ expires_at: expires,
    tenant: { name: a.full_name, email: a.email, unit: a.unit_number,
              locale: a.locale } });
});

/**
 * Who this account is and what it can reach.
 *
 * The front end asks this first and shows one of two things. Somebody without
 * a suite gets viewings, applications and anything waiting to be signed —
 * not a set of empty panels labelled Rent and Repairs, which reads as broken
 * rather than as not-yet.
 */
r.get("/tenant/me", async (c) => {
  const sql = c.get("db");
  const t = c.get("tenant");

  const [account] = await sql`
    SELECT account_state, unit_number, lease_id, email_verified_at
    FROM tenant_accounts WHERE id = ${t.id}`;

  const isTenant = account?.account_state === "tenant" && account.unit_number;

  if (!isTenant) {
    const [{ count: viewings }] = await sql`
      SELECT COUNT(*)::int AS count FROM showing_requests WHERE account_id = ${t.id}`;
    const [{ count: applications }] = await sql`
      SELECT COUNT(*)::int AS count FROM applications WHERE account_id = ${t.id}`;
    const [{ count: toSign }] = await sql`
      SELECT COUNT(*)::int AS count FROM signature_parties sp
      JOIN signature_requests sr ON sr.id = sp.request_id
      WHERE lower(sp.email) = ${String(t.email).toLowerCase()}
        AND sp.signed_at IS NULL AND sr.state IN ('sent','viewed','signed')`;

    return c.json({
      tenant: { name: t.name, email: t.email, locale: t.locale },
      account_state: account?.account_state ?? "prospect",
      email_verified: !!account?.email_verified_at,
      unit: null, lease: null,
      counts: { viewings, applications, to_sign: toSign },
      // What is available now, and what is not yet. Said as a sequence rather
      // than as a set of locked doors.
      available: ["viewings", "applications", "signing"],
      pending: ["rent", "ledger", "repairs", "notices"],
      note: "Rent, your statement and repairs appear here once your lease is signed and we connect this account to your suite.",
    });
  }

  const unit = account.unit_number;
  const [lease] = account.lease_id
    ? await sql`SELECT start_date, end_date, term_type, rent, deposit FROM leases
        WHERE id = ${account.lease_id}` : [null];

  const [parking] = await sql`
    SELECT pa.status, pa.requested_at, pp.label_en, pp.code
    FROM parking_allocations pa JOIN parking_pools pp ON pp.code = pa.pool_code
    WHERE pa.unit_number = ${unit} AND pa.status <> 'released'`;

  let position = null;
  if (parking?.status === "waiting") {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM parking_allocations
      WHERE pool_code = ${parking.code} AND status = 'waiting'
        AND requested_at <= ${parking.requested_at}`;
    position = count;
  }

  const charges = await sql`
    SELECT period, kind, amount, paid_amount, due_date FROM ar_charges
    WHERE unit_number = ${unit} AND state IN ('open','partial')
    ORDER BY due_date`;

  const owed = charges.reduce((s, x) => s + Number(x.amount) - Number(x.paid_amount), 0);
  const overdue = charges
    .filter((x) => new Date(x.due_date) < new Date())
    .reduce((s, x) => s + Number(x.amount) - Number(x.paid_amount), 0);

  return c.json({
    tenant: { name: t.name, email: t.email, unit, locale: t.locale },
    account_state: "tenant",
    email_verified: !!account.email_verified_at,
    unit, lease: lease ?? null,
    parking: parking
      ? { status: parking.status, label: parking.label_en, waitlist_position: position }
      : null,
    balance: Number(owed.toFixed(2)),
    overdue: Number(overdue.toFixed(2)),
    charges,
    available: ["rent", "ledger", "repairs", "notices", "documents"],
    pending: [],
  });
});

/* The old shape, kept so nothing breaks mid-port. */
r.get("/tenant/summary", async (c) => {
  const sql = c.get("db");
  const unit = tenantUnit(c);
  const t = c.get("tenant");

  const [lease] = t.leaseId
    ? await sql`SELECT start_date, end_date, term_type, rent FROM leases
        WHERE id = ${t.leaseId}` : [null];

  const [parking] = await sql`
    SELECT pa.status, pa.requested_at, pp.label_en, pp.code
    FROM parking_allocations pa JOIN parking_pools pp ON pp.code = pa.pool_code
    WHERE pa.unit_number = ${unit} AND pa.status <> 'released'`;

  let position = null;
  if (parking?.status === "waiting") {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM parking_allocations
      WHERE pool_code = ${parking.code} AND status = 'waiting'
        AND requested_at <= ${parking.requested_at}`;
    position = count;
  }

  const charges = await sql`
    SELECT period, kind, amount, paid_amount, due_date FROM ar_charges
    WHERE unit_number = ${unit} AND state IN ('open','partial')
    ORDER BY due_date`;

  return c.json({
    tenant: { name: t.name, email: t.email, unit, locale: t.locale },
    lease: lease ?? null,
    parking: parking
      ? { status: parking.status, label: parking.label_en, waitlist_position: position }
      : null,
    balance: charges.reduce((sum, x) => sum + Number(x.amount) - Number(x.paid_amount), 0),
    charges,
  });
});


/* ============================================================
   What a prospect can reach
   ============================================================ */

/** Their own viewings. Nothing about anybody else's, and nothing about which
 *  slots exist — that is the public endpoint. */
r.get("/tenant/viewings", async (c) => {
  const t = c.get("tenant");
  return c.json({ viewings: await c.get("db")`
    SELECT sr.id, sr.reference, sr.unit_type, sr.requested_date,
           sr.requested_time, sr.state, sr.created_at,
           e.starts_at, e.duration_min, e.unit_number
    FROM showing_requests sr
    LEFT JOIN events e ON e.id = sr.event_id
    WHERE sr.account_id = ${t.id}
    ORDER BY COALESCE(e.starts_at, sr.requested_time) DESC NULLS LAST
    LIMIT 50` });
});

/** Book only a slot the server is still offering. The session supplies the
 * identity, and the transaction plus advisory lock prevents two simultaneous
 * clicks from reserving the same staff time. */
r.post("/tenant/viewings", async (c) => {
  const sql = c.get("db");
  const t = c.get("tenant");
  const body = await c.req.json().catch(() => ({}));
  const unitType = String(body.unit_type ?? "").trim() || null;
  const requestedDate = String(body.requested_date ?? "");
  const requestedClock = String(body.requested_time ?? "");
  const requestId = String(body.client_request_id ?? "").slice(0, 80) || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ||
      !/^\d{2}:\d{2}$/.test(requestedClock))
    return c.json({ code: "INVALID_SLOT" }, 400);

  if (unitType) {
    const [known] = await sql`SELECT code FROM unit_types WHERE code = ${unitType}`;
    if (!known) return c.json({ code: "UNIT_TYPE_NOT_FOUND" }, 404);
  }

  if (requestId) {
    const [existing] = await sql`SELECT reference, requested_date, requested_time,
      unit_type, state FROM showing_requests
      WHERE account_id = ${t.id} AND client_request_id = ${requestId}`;
    if (existing) return c.json({ booking: existing, repeated: true });
  }

  const offered = await availableSlots(sql, unitType);
  const day = offered.days.find((d) => d.date === requestedDate);
  if (!day?.slots.includes(requestedClock))
    return c.json({ code: "SLOT_NOT_AVAILABLE", detail: "Choose another time." }, 409);

  const startsAt = edmontonInstant(requestedDate, requestedClock);
  const endsAt = new Date(startsAt.getTime() + 30 * 60000);
  const reference = `V${Date.now().toString(36).toUpperCase()}${crypto.randomUUID()
    .replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  const [showingAssignee] = await sql`
    SELECT id, full_name FROM users
    WHERE role_code = 'building_manager' AND is_active
    ORDER BY full_name, id LIMIT 1`;
  if (!showingAssignee)
    return c.json({ code: "ACTIVE_BUILDING_MANAGER_REQUIRED" }, 503);

  try {
    const booking = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(
        ${`showing:${requestedDate}:${requestedClock}`}))`;
      const [conflict] = await tx`SELECT EXISTS (
        SELECT 1 FROM events WHERE state = 'booked' AND blocking
          AND starts_at < ${endsAt.toISOString()}
          AND starts_at + duration_min * INTERVAL '1 minute' > ${startsAt.toISOString()}
      ) AS taken`;
      if (conflict.taken)
        throw Object.assign(new Error("SLOT_NOT_AVAILABLE"), { status: 409 });

      const eventId = uid("ev_");
      await tx`INSERT INTO events (id, type, contact_name, contact_info,
        assignee_id, assignee, starts_at, duration_min, blocking, state, created_via)
        VALUES (${eventId}, 'showing', ${t.name},
                ${[t.email, body.phone].filter(Boolean).join(" · ")},
                ${showingAssignee.id}, ${showingAssignee.full_name},
                ${startsAt.toISOString()}, 30, TRUE, 'booked', 'tenant_portal')`;

      const [row] = await tx`INSERT INTO showing_requests
        (id, reference, unit_type, requested_date, requested_time, name, email,
         phone, notes, locale, event_id, state, account_id, client_request_id)
        VALUES (${uid("sr_")}, ${reference}, ${unitType}, ${requestedDate},
                ${startsAt.toISOString()}, ${t.name}, ${t.email},
                ${body.phone ?? null}, ${String(body.notes ?? "").slice(0, 2000) || null},
                ${body.locale ?? t.locale ?? "en"}, ${eventId}, 'confirmed',
                ${t.id}, ${requestId})
        RETURNING reference, unit_type, requested_date, requested_time, state`;
      return row;
    });
    return c.json({ booking }, 201);
  } catch (e) {
    if (e.status === 409 || e.code === "23505")
      return c.json({ code: "SLOT_NOT_AVAILABLE", detail: "Choose another time." }, 409);
    throw e;
  }
});

/** Their own applications and where each one has got to.
 *
 *  Somebody who applied a week ago has a reasonable question, and the answer
 *  being on a screen they can open themselves is better for everybody than
 *  the answer being a phone call.
 */
r.get("/tenant/applications", async (c) => {
  const t = c.get("tenant");
  const rows = await c.get("db")`
    SELECT id, reference, unit_type, state, move_in, occupants, created_at, decided_at
    FROM applications WHERE account_id = ${t.id}
    ORDER BY created_at DESC LIMIT 20`;

  return c.json({ applications: rows.map((a) => ({ ...a,
    // Said in words rather than a status code. "screening" means nothing to
    // the person waiting.
    plain: a.state === "new" ? "With us. We will be in touch."
      : ["screening", "review"].includes(a.state) ? "Being reviewed."
      : a.state === "approved" ? "Approved. We will send the agreement to sign."
      : a.state === "declined" ? "Not proceeding. We have written to you separately."
      : a.state === "withdrawn" ? "Withdrawn."
      : a.state })) });
});

/** Submit an application with pricing calculated from the active database
 * profile. Totals supplied by the browser are deliberately ignored. */
r.post("/tenant/applications", async (c) => {
  const sql = c.get("db");
  const t = c.get("tenant");
  const body = await c.req.json().catch(() => ({}));
  const unitType = String(body.unit_type ?? "").trim();
  const moveIn = String(body.move_in ?? "");
  const term = String(body.term ?? "");
  const occupants = Number(body.occupants);
  const tenants = Array.isArray(body.tenants)
    ? body.tenants.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [];
  const pets = ["none", "cat", "dog", "both"].includes(body.pets) ? body.pets : "none";
  const requestId = String(body.client_request_id ?? "").slice(0, 80) || null;

  if (!unitType || !/^\d{4}-\d{2}-\d{2}$/.test(moveIn) ||
      !["6", "12", "monthly"].includes(term) || tenants.length === 0 ||
      !Number.isInteger(occupants) || occupants < 1 || occupants > 20 ||
      !body.fee_ack || !body.consent)
    return c.json({ code: "INVALID_APPLICATION" }, 400);

  if (requestId) {
    const [existing] = await sql`SELECT reference, state, monthly_total, upfront_total
      FROM applications WHERE account_id = ${t.id} AND client_request_id = ${requestId}`;
    if (existing) return c.json({ application: existing, repeated: true });
  }

  const [price] = await sql`
    SELECT r.base_rent, f.deposit_mode, f.deposit_fixed, f.cat_deposit,
           f.dog_deposit, f.pet_rent, f.parking_underground, f.storage_fee,
           f.application_fee
    FROM pricing_profiles p
    JOIN unit_type_rents r ON r.pricing_profile_id = p.id
      AND r.unit_type_code = ${unitType}
    LEFT JOIN fee_settings f ON f.pricing_profile_id = p.id
    WHERE p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    ORDER BY p.effective_from DESC LIMIT 1`;
  if (!price) return c.json({ code: "UNIT_TYPE_NOT_AVAILABLE" }, 409);

  const rent = Number(price.base_rent);
  const serviceAnimal = !!body.service_animal;
  const petCount = serviceAnimal || pets === "none" ? 0 : pets === "both" ? 2 : 1;
  const petMonthly = petCount * Number(price.pet_rent ?? 0);
  const parking = body.wants_parking ? Number(price.parking_underground ?? 0) : 0;
  const storage = body.wants_storage ? Number(price.storage_fee ?? 0) : 0;
  const monthlyTotal = rent + petMonthly + parking + storage;
  const baseDeposit = price.deposit_mode === "fixed"
    ? Number(price.deposit_fixed ?? 0) : rent;
  const petDeposit = serviceAnimal ? 0
    : (pets === "cat" ? Number(price.cat_deposit ?? 0)
      : pets === "dog" ? Number(price.dog_deposit ?? 0)
      : pets === "both" ? Number(price.cat_deposit ?? 0) + Number(price.dog_deposit ?? 0)
      : 0);
  // Any pet portion sits inside the one-month refundable-deposit ceiling; it
  // is not silently added on top of a full one-month security deposit.
  const refundableDeposit = Math.min(rent, Math.max(baseDeposit, petDeposit));
  const upfrontTotal = refundableDeposit + monthlyTotal + Number(price.application_fee ?? 0);
  const reference = `A${Date.now().toString(36).toUpperCase()}${crypto.randomUUID()
    .replace(/-/g, "").slice(0, 4).toUpperCase()}`;

  try {
    const application = await sql.begin(async (tx) => {
      const [row] = await tx`INSERT INTO applications
        (id, reference, unit_type, move_in, term, tenants, occupants, email, phone,
         wants_parking, wants_storage, pets, service_animal, monthly_total,
         upfront_total, fee_ack, consent, locale, state, account_id,
         client_request_id)
        VALUES (${uid("ap_")}, ${reference}, ${unitType}, ${moveIn}, ${term},
                ${JSON.stringify(tenants)}, ${occupants}, ${t.email},
                ${body.phone ?? null}, ${!!body.wants_parking},
                ${!!body.wants_storage}, ${pets}, ${serviceAnimal},
                ${monthlyTotal.toFixed(2)}, ${upfrontTotal.toFixed(2)}, TRUE, TRUE,
                ${body.locale ?? t.locale ?? "en"}, 'new', ${t.id}, ${requestId})
        RETURNING reference, state, monthly_total, upfront_total`;
      await tx`INSERT INTO notifications (id, audience, kind, code, params, link)
        VALUES (${uid("nt_")}, 'property_manager', 'application',
                'APPLICATION_SUBMITTED',
                ${JSON.stringify({ reference, unit_type: unitType, move_in: moveIn })},
                ${`/leasing?application=${reference}`})`;
      return row;
    });
    return c.json({ application }, 201);
  } catch (e) {
    if (e.code === "23505" && requestId) {
      const [existing] = await sql`SELECT reference, state, monthly_total, upfront_total
        FROM applications WHERE account_id = ${t.id} AND client_request_id = ${requestId}`;
      if (existing) return c.json({ application: existing, repeated: true });
    }
    throw e;
  }
});

/** Agreements waiting for a signature. A prospect signs a lease before they
 *  are a tenant, so this is not gated on having a suite. */
r.get("/tenant/to-sign", async (c) => {
  const t = c.get("tenant");
  return c.json({ pending: await c.get("db")`
    SELECT sr.id, sr.reference, sr.unit_number, sr.expires_at, sr.state,
           ag.name_en, ag.name_zh, sp.access_token
    FROM signature_requests sr
    JOIN signature_parties sp ON sp.request_id = sr.id
    JOIN agreements ag ON ag.id = sr.agreement_id
    WHERE lower(sp.email) = ${String(t.email).toLowerCase()}
      AND sp.signed_at IS NULL AND sp.declined_at IS NULL
      AND sr.state IN ('sent','viewed','signed')
    ORDER BY sr.expires_at` });
});

/* ============================================================
   What needs a suite
   ============================================================ */

/**
 * Their own ledger.
 *
 * Everything charged, everything paid, and what the deposit is doing. This
 * is the screen that answers most of what a tenant would otherwise ring
 * about, and the one that prevents the argument at move-out — a deposit
 * somebody has been able to see all along is not a surprise when it is
 * returned less a deduction.
 *
 * Only their own suite. The unit comes from the session.
 */
r.get("/tenant/ledger", async (c) => {
  const sql = c.get("db");
  const unit = tenantUnit(c);
  const t = c.get("tenant");

  const charges = await sql`
    SELECT id, period, kind, gl_code, amount, paid_amount, charge_date, due_date, state
    FROM ar_charges WHERE unit_number = ${unit} AND state <> 'void'
    ORDER BY due_date DESC, charge_date DESC LIMIT 200`;

  const receipts = await sql`
    SELECT rc.id, rc.amount, rc.received_date, rc.method, rc.reference
    FROM ar_receipts rc WHERE rc.unit_number = ${unit}
    ORDER BY rc.received_date DESC LIMIT 200`;

  /* The deposit is a ledger, not a balance.
     
     Received, interest, deductions and refunds are separate movements, and
     showing only a total hides the one thing a tenant actually wants to see:
     what was taken out and on what basis. That is what move-out disputes are
     about, and a deduction the tenant first learns of at the end is a
     deduction they will contest.
     
     Shown separately from rent because it is their money being held, not rent
     already paid. */
  const depositRows = await sql`
    SELECT kind, amount, txn_date, basis FROM deposit_ledger
    WHERE unit_number = ${unit} ORDER BY txn_date, kind`;

  const depositTotal = depositRows.reduce((sum, x) => sum + Number(x.amount), 0);
  const deposit = depositRows.length ? {
    held: Number(depositTotal.toFixed(2)),
    received: Number(depositRows.filter((x) => x.kind === "received")
      .reduce((s, x) => s + Number(x.amount), 0).toFixed(2)),
    interest: Number(depositRows.filter((x) => x.kind === "interest")
      .reduce((s, x) => s + Number(x.amount), 0).toFixed(2)),
    deductions: depositRows.filter((x) => x.kind === "deduction"),
    refunded: Number(depositRows.filter((x) => x.kind === "refund")
      .reduce((s, x) => s + Math.abs(Number(x.amount)), 0).toFixed(2)),
    movements: depositRows,
  } : null;

  const [lease] = t.leaseId
    ? await sql`SELECT start_date, end_date, term_type, rent, deposit
        FROM leases WHERE id = ${t.leaseId}` : [null];

  const outstanding = charges
    .filter((x) => ["open", "partial"].includes(x.state))
    .reduce((sum, x) => sum + Number(x.amount) - Number(x.paid_amount), 0);

  const overdue = charges
    .filter((x) => ["open", "partial"].includes(x.state)
      && new Date(x.due_date) < new Date())
    .reduce((sum, x) => sum + Number(x.amount) - Number(x.paid_amount), 0);

  return c.json({
    unit, lease: lease ?? null,
    charges, receipts,
    deposit: deposit ? {
      ...deposit,
      // Alberta requires interest on a security deposit. Showing it means the
      // tenant can check the figure rather than take it on trust at move-out.
      note: "Held in a trust account, separately from rent. Interest is added as required.",
    } : null,
    summary: {
      outstanding: Number(outstanding.toFixed(2)),
      overdue: Number(overdue.toFixed(2)),
      // The number people actually want. Everything else is working.
      balance_owed: Number(outstanding.toFixed(2)),
    },
  });
});

/**
 * The same thing as a file.
 *
 * A tenant asking their bank, a lawyer or a subsidy office for proof of what
 * they paid should not have to ask the office for it. Plain text rather than
 * a PDF, because it opens everywhere and nothing about it needs to be
 * rendered.
 */
r.get("/tenant/ledger/download", async (c) => {
  const sql = c.get("db");
  const unit = tenantUnit(c);
  const t = c.get("tenant");

  const charges = await sql`
    SELECT period, kind, amount, paid_amount, charge_date, due_date, state
    FROM ar_charges WHERE unit_number = ${unit} AND state <> 'void'
    ORDER BY due_date`;
  const receipts = await sql`
    SELECT amount, received_date, method, reference FROM ar_receipts
    WHERE unit_number = ${unit} ORDER BY received_date`;
  const depositRows = await sql`
    SELECT kind, amount, txn_date, basis FROM deposit_ledger
    WHERE unit_number = ${unit} ORDER BY txn_date, kind`;

  const money = (n) => new Intl.NumberFormat("en-CA",
    { style: "currency", currency: "CAD" }).format(Number(n ?? 0));

  const totalCharged = charges.reduce((s, x) => s + Number(x.amount), 0);
  const totalPaid = receipts.reduce((s, x) => s + Number(x.amount), 0);

  const lines = [
    `STATEMENT OF ACCOUNT`,
    `Baydo Pointe · ${unit}`,
    `${t.name}`,
    `Produced ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `CHARGED`,
    ...charges.map((x) =>
      `  ${x.due_date}  ${String(x.kind).padEnd(12)} ${money(x.amount).padStart(12)}` +
      `  paid ${money(x.paid_amount).padStart(12)}  ${x.state}`),
    `  ${"".padEnd(14)}${"Total".padEnd(12)} ${money(totalCharged).padStart(12)}`,
    ``,
    `RECEIVED`,
    ...receipts.map((x) =>
      `  ${x.received_date}  ${money(x.amount).padStart(12)}  ${x.method ?? ""}` +
      `${x.reference ? `  ${x.reference}` : ""}`),
    `  ${"".padEnd(14)}${money(totalPaid).padStart(12)}`,
    ``,
    depositRows.length ? `SECURITY DEPOSIT` : `NO SECURITY DEPOSIT ON FILE`,
    ...depositRows.map((d) =>
      `  ${d.txn_date}  ${String(d.kind).padEnd(10)} ${money(d.amount).padStart(12)}` +
      // The basis for a deduction is on the statement, not only in a letter.
      // A tenant who can see what was taken and why has something to disagree
      // with; one who cannot has only the number.
      (d.basis ? `  ${d.basis}` : "")),
    ...(depositRows.length ? [
      `  ${"".padEnd(12)}${"Held".padEnd(10)} ${money(depositRows.reduce((s, x) => s + Number(x.amount), 0)).padStart(12)}`,
      ``,
      `  Held in a trust account, separately from rent. It is your money being`,
      `  held, not rent already paid, and it comes back at the end of the`,
      `  tenancy less anything properly deducted.`,
    ] : []),
    ``,
    `BALANCE`,
    `  Charged less received: ${money(totalCharged - totalPaid)}`,
    ``,
    `This statement is produced from our records. If something here does not`,
    `match yours, tell us — it is easier to sort out now than at move-out.`,
  ];

  const body = lines.join("\n");
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition",
    `attachment; filename="statement-${unit}-${new Date().toISOString().slice(0, 10)}.txt"`);
  return c.body(body);
});

r.get("/tenant/notices", async (c) => {
  const unit = tenantUnit(c);
  return c.json({ notices: await c.get("db")`
    SELECT id, purpose, entry_date, window_from, window_to, body, sent_at
    FROM entry_notices WHERE unit_number = ${unit} AND state = 'sent'
    ORDER BY entry_date DESC LIMIT 50` });
});

r.get("/tenant/repairs", async (c) => {
  const unit = tenantUnit(c);
  return c.json({ repairs: await c.get("db")`
    SELECT tr.id, tr.what, tr.where_in_unit, tr.urgent, tr.created_at,
           COALESCE(m.state, tr.state) AS ticket_state, m.scheduled_at, m.vendor
    FROM tenant_repairs tr LEFT JOIN maintenance m ON m.id = tr.ticket_id
    WHERE tr.unit_number = ${unit} ORDER BY tr.created_at DESC` });
});

/**
 * Reporting a repair creates the ticket directly.
 *
 * A form that queues a request for somebody to retype is a step where things
 * get lost, and the thing that gets lost is usually the one somebody was
 * hesitant to report.
 */
r.post("/tenant/repairs", async (c) => {
  const sql = c.get("db");
  const unit = tenantUnit(c);
  const t = c.get("tenant");
  const { what, where_in_unit, urgent, category } = await c.req.json();
  if (!what?.trim()) return c.json({ code: "DESCRIPTION_REQUIRED" }, 400);

  const out = await sql.begin(async (tx) => {
    const ticketId = uid("mt_");
    await tx`INSERT INTO maintenance (id, unit_number, tenant_name, category,
      priority, description, rush)
      VALUES (${ticketId}, ${unit}, ${t.name}, ${category ?? "other"},
              ${urgent ? "emergency" : "normal"},
              ${`${what.trim()}${where_in_unit ? ` (${where_in_unit})` : ""}`}, FALSE)`;
    const id = uid("tr_");
    await tx`INSERT INTO tenant_repairs (id, account_id, unit_number, what,
      where_in_unit, urgent, ticket_id)
      VALUES (${id}, ${t.id}, ${unit}, ${what.trim()}, ${where_in_unit ?? null},
              ${!!urgent}, ${ticketId})`;
    return { id, ticket_id: ticketId };
  });

  // Urgent goes straight through. A leak sitting behind three other tickets
  // because a form was polite about it is the failure worth avoiding.
  await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
    VALUES (${uid("nt_")}, 'building_manager',
            ${urgent ? "emergency" : "maintenance"},
            ${urgent ? "URGENT_REPAIR_REPORTED" : "REPAIR_REPORTED"},
            ${JSON.stringify({ unit, what: what.trim().slice(0, 120) })},
            ${`/site?ticket=${out.ticket_id}`})`;

  return c.json({ ...out, urgent: !!urgent }, 201);
});

/**
 * Forgotten password.
 *
 * The same shape as the staff one and for the same reasons: identical
 * response either way, token hashed at rest, every other session ended on
 * success because whoever asked may have done so precisely because somebody
 * else had the old password.
 */
r.post("/public/tenant/forgot", async (c) => {
  const sql = c.get("db");
  const { email } = await c.req.json().catch(() => ({}));
  const [a] = await sql`SELECT * FROM tenant_accounts
    WHERE lower(email) = ${String(email ?? "").trim().toLowerCase()} AND is_active`;

  if (a) {
    const raw = randToken();
    await sql.begin(async (tx) => {
      await tx`UPDATE email_verifications SET used_at = now()
        WHERE purpose = 'tenant_reset' AND lower(email) = ${a.email.toLowerCase()}
          AND used_at IS NULL`;
      await tx`INSERT INTO email_verifications (id, purpose, email, unit_number,
        lease_id, contact_id, full_name, locale, token_hash, expires_at)
        VALUES (${uid("ev_")}, 'tenant_reset', ${a.email.toLowerCase()},
                ${a.unit_number}, ${a.lease_id}, ${a.contact_id}, ${a.full_name},
                ${a.locale ?? "en"}, ${await sha256(raw)},
                ${new Date(Date.now() + 30 * 60000).toISOString()})`;
      const zh = a.locale === "zh";
      await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
        subject, body, ref_type, ref_id)
        VALUES (${uid("ob_")}, 'email', ${a.email}, ${a.full_name},
                ${a.locale ?? "en"}, 'password_reset',
                ${zh ? "重設住戶專區密碼" : "Reset your Baydo Pointe password"},
                ${(zh ? [
                  `${a.full_name} 你好，`, "",
                  "有人要求重設你的住戶專區密碼。30 分鐘內開啟以下連結即可設定新密碼：",
                  "", `${c.env.PUBLIC_TENANT_URL}/reset?token=${raw}`, "",
                  "如果不是你要求的，忽略這封信即可，不會有任何變動。",
                ] : [
                  `Hello ${a.full_name},`, "",
                  "Someone asked to reset the password on your Baydo Pointe account.",
                  "Open this within 30 minutes to choose a new one:",
                  "", `${c.env.PUBLIC_TENANT_URL}/reset?token=${raw}`, "",
                  "If that was not you, ignore this — nothing has changed.",
                ]).join("\n")},
                'unit', ${a.unit_number})`;
    });
  }

  // Identical whether or not the account exists.
  return c.json({ ok: true, code: "RESET_SENT_IF_EXISTS" });
});

r.post("/public/tenant/reset", async (c) => {
  const sql = c.get("db");
  const { token, password } = await c.req.json().catch(() => ({}));
  if (!token || !password) return c.json({ code: "MISSING_FIELDS" }, 400);
  if (String(password).length < 12)
    return c.json({ code: "PASSWORD_TOO_WEAK",
      issues: ["At least 12 characters."] }, 400);

  const hash = await sha256(token);
  try {
    await sql.begin(async (tx) => {
      const [v] = await tx`SELECT * FROM email_verifications
        WHERE token_hash = ${hash} AND purpose = 'tenant_reset' FOR UPDATE`;
      if (!v) throw Object.assign(new Error("INVALID_TOKEN"), { status: 404 });
      if (v.used_at) throw Object.assign(new Error("ALREADY_USED"), { status: 410 });
      if (new Date(v.expires_at) < new Date())
        throw Object.assign(new Error("EXPIRED"), { status: 410 });

      const h = await hashPassword(password, tx);
      await tx`UPDATE tenant_accounts SET password_algo = ${h.algo},
        password_salt = ${h.salt}, password_hash = ${h.hash},
        password_params = ${h.params}, password_changed_at = now(),
        failed_attempts = 0, locked_until = NULL
        WHERE lower(email) = ${v.email.toLowerCase()} AND is_active`;
      await tx`UPDATE email_verifications SET used_at = now() WHERE id = ${v.id}`;
      // Every other session ends.
      await tx`UPDATE tenant_sessions SET revoked_at = now()
        WHERE account_id IN (SELECT id FROM tenant_accounts
                             WHERE lower(email) = ${v.email.toLowerCase()})
          AND revoked_at IS NULL`;
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ code: e.message }, e.status ?? 500);
  }
});

r.post("/tenant/logout", async (c) => {
  const t = c.get("tenant");
  await c.get("db")`UPDATE tenant_sessions SET revoked_at = now()
    WHERE id = ${t.sessionId}`;
  c.header("Set-Cookie", "baydo_tenant_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0");
  return c.json({ ok: true });
});

export default r;
