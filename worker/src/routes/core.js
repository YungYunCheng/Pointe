import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";

/* ============================================================
   Units, pricing, parking

   The parking allocation is the reason this system needs a real
   database rather than a key-value store. Two people clicking
   "give them the last stall" in the same second is not a rare
   case — it is what happens on the day a building fills up.

   SQLite handled it with an immediate transaction, which locks
   the whole file. Postgres does it with SELECT ... FOR UPDATE,
   which locks one row and lets everything else carry on.
   ============================================================ */

const r = new Hono();

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Rent status is derived, never stored as a checkbox.  A stored "paid" flag
 * becomes false information on the first of the next month; deriving it from
 * the active lease, this month's rent charge and the account balance makes the
 * rollover automatic. */
export function rentStatus(resident, financial) {
  if (!resident) return {
    code: "vacant", label: "Vacant", period: financial?.period ?? null,
    is_paid: false, outstanding_balance: 0, prepayment: 0,
  };

  const f = financial ?? {};
  const outstanding = Math.max(0, cents(f.balance ?? 0));
  const prepayment = Math.max(0, cents(-(f.balance ?? 0)));
  const due = cents(f.current_rent_due ?? 0);
  const postedPaid = cents(f.current_rent_paid ?? 0);
  const availableCredit = Math.max(0, cents(f.available_credit ?? 0));
  const paid = cents(postedPaid + Math.min(availableCredit, Math.max(0, due - postedPaid)));
  const remaining = Math.max(0, cents(due - paid));
  const common = {
    period: f.period ?? null,
    current_rent_due: due,
    current_rent_paid: paid,
    current_rent_outstanding: remaining,
    outstanding_balance: outstanding,
    prepayment,
  };

  if (String(resident.start_date).slice(0, 10) > String(f.local_today ?? ""))
    return { ...common, code: "awaiting_move_in", label: "Awaiting move-in",
      is_paid: false };

  if (due <= 0.005)
    return prepayment > 0.005
      ? { ...common, code: "prepaid", label: "Prepaid", is_paid: true }
      : { ...common, code: "not_billed", label: "Not billed", is_paid: false };

  if (prepayment > 0.005)
    return { ...common, code: "prepaid", label: "Prepaid", is_paid: true };
  if (paid >= due - 0.005 || (remaining > 0.005 && outstanding <= 0.005))
    return { ...common, code: "paid", label: "Rent paid", is_paid: true };
  if (paid > 0.005)
    return { ...common, code: "partial", label: "Partially paid", is_paid: false };
  return { ...common, code: "outstanding", label: "Rent outstanding", is_paid: false };
}

/* ---------- Units ---------- */

r.get("/units", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const units = await sql`
    SELECT u.*, t.bedroom_label_en, t.bedroom_label_zh, t.area_sqft, t.balcony_sqft,
           t.is_mirrored
    FROM units u JOIN unit_types t ON t.code = u.unit_type_code
    ORDER BY u.building_code, u.unit_number`;

  const rents = await sql`
    SELECT r.unit_type_code, r.base_rent
    FROM unit_type_rents r
    JOIN pricing_profiles p ON p.id = r.pricing_profile_id
    WHERE p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)`;
  const rentBy = Object.fromEntries(rents.map((x) => [x.unit_type_code, x.base_rent]));

  /* A unit register without the current resident is only a vacancy board.
   * Keep tenancy data relational and assemble the Yardi-style unit card here:
   * lease/contact is the source of truth, the portal account only says whether
   * that resident can sign in, and parking remains its own allocation record. */
  const residents = await sql`
    SELECT DISTINCT ON (l.unit_number)
      l.unit_number, l.id AS lease_id, l.start_date, l.end_date, l.term_type,
      l.rent, l.deposit, l.occupants, l.status AS lease_status,
      ct.id AS contact_id, ct.full_name, ct.email, ct.phone, ct.locale,
      ta.id AS account_id, ta.account_state, ta.email_verified_at,
      app.pets, app.wants_parking, app.wants_storage
    FROM leases l
    LEFT JOIN contacts ct ON ct.id = l.contact_id
    LEFT JOIN tenant_accounts ta
      ON ta.lease_id = l.id AND ta.is_active AND ta.account_state = 'tenant'
    LEFT JOIN LATERAL (
      SELECT a.pets, a.wants_parking, a.wants_storage
      FROM applications a
      WHERE (ta.id IS NOT NULL AND a.account_id = ta.id)
         OR (ct.email IS NOT NULL AND lower(a.email) = lower(ct.email))
      ORDER BY a.created_at DESC LIMIT 1
    ) app ON TRUE
    WHERE l.status = 'active'
    ORDER BY l.unit_number, l.start_date DESC, l.created_at DESC`;
  const residentBy = Object.fromEntries(residents.map((x) => [x.unit_number, x]));

  /* Scope every amount to the active lease.  A suite can have years of prior
   * residents; an old tenant's arrears must never make the new resident look
   * unpaid.  Dates use Edmonton time because that is where the property is. */
  const financials = await sql`
    WITH clock AS (
      SELECT (now() AT TIME ZONE 'America/Edmonton')::date AS local_today
    ), charge_totals AS (
      SELECT c.lease_id, COALESCE(SUM(c.amount), 0) AS charges
      FROM ar_charges c, clock
      WHERE c.state <> 'void' AND c.lease_id IS NOT NULL
        AND c.charge_date <= clock.local_today
      GROUP BY c.lease_id
    ), payment_totals AS (
      SELECT p.lease_id, COALESCE(SUM(p.amount), 0) AS payments
      FROM payments p, clock
      WHERE p.lease_id IS NOT NULL AND p.purpose <> 'deposit'
        AND p.state IN ('authorised','settled')
        AND COALESCE(p.received_on, p.created_at::date) <= clock.local_today
      GROUP BY p.lease_id
    ), current_rent AS (
      SELECT c.lease_id, COALESCE(SUM(c.amount), 0) AS amount,
             COALESCE(SUM(c.paid_amount), 0) AS paid
      FROM ar_charges c, clock
      WHERE c.state <> 'void' AND c.kind = 'rent'
        AND c.period = to_char(clock.local_today, 'YYYY-MM')
      GROUP BY c.lease_id
    ), application_totals AS (
      SELECT p.lease_id, COALESCE(SUM(pa.amount), 0) AS applied
      FROM payments p
      JOIN payment_applications pa ON pa.payment_id = p.id
      WHERE p.lease_id IS NOT NULL AND p.purpose <> 'deposit'
        AND p.state IN ('authorised','settled')
      GROUP BY p.lease_id
    )
    SELECT l.unit_number, l.id AS lease_id,
      clock.local_today::text AS local_today,
      to_char(clock.local_today, 'YYYY-MM') AS period,
      COALESCE(cr.amount, 0) AS current_rent_due,
      COALESCE(cr.paid, 0) AS current_rent_paid,
      GREATEST(0, COALESCE(pt.payments, 0) - COALESCE(at.applied, 0)) AS available_credit,
      COALESCE(ct.charges, 0) - COALESCE(pt.payments, 0) AS balance
    FROM leases l CROSS JOIN clock
    LEFT JOIN charge_totals ct ON ct.lease_id = l.id
    LEFT JOIN payment_totals pt ON pt.lease_id = l.id
    LEFT JOIN current_rent cr ON cr.lease_id = l.id
    LEFT JOIN application_totals at ON at.lease_id = l.id
    WHERE l.status = 'active'`;
  const financialBy = Object.fromEntries(financials.map((x) => [x.unit_number, x]));

  const parking = await sql`
    SELECT unit_number, json_agg(json_build_object(
      'id', id, 'pool_code', pool_code, 'status', status,
      'assigned_at', assigned_at, 'requested_at', requested_at
    ) ORDER BY requested_at) AS allocations
    FROM parking_allocations
    WHERE status IN ('assigned','waiting')
    GROUP BY unit_number`;
  const parkingBy = Object.fromEntries(parking.map((x) => [x.unit_number, x.allocations ?? []]));

  const enriched = units.map((u) => {
    const resident = residentBy[u.unit_number] ?? null;
    const marketRent = u.rent_override ?? rentBy[u.unit_type_code] ?? null;
    return { ...u,
      market_rent: marketRent,
      current_rent: resident?.rent ?? marketRent,
      resident,
      parking: parkingBy[u.unit_number] ?? [],
      rent_status: rentStatus(resident, financialBy[u.unit_number]),
    };
  });

  return c.json({
    units: enriched,
    counts: units.reduce((acc, u) => {
      acc[u.status] = (acc[u.status] ?? 0) + 1;
      return acc;
    }, {}),
  });
});

r.patch("/units/:unit", require_("units.status.edit"), async (c) => {
  const sql = c.get("db");
  const body = await c.req.json();
  const { status, available_from, rent_override } = body;
  const notes = Object.prototype.hasOwnProperty.call(body, "notes") ? body.notes : body.note;
  const hasDate = Object.prototype.hasOwnProperty.call(body, "available_from");
  const hasRent = Object.prototype.hasOwnProperty.call(body, "rent_override");
  const hasNotes = Object.prototype.hasOwnProperty.call(body, "notes") ||
    Object.prototype.hasOwnProperty.call(body, "note");
  const unit = c.req.param("unit");

  const [before] = await sql`SELECT * FROM units WHERE unit_number = ${unit}`;
  if (!before) return c.json({ code: "UNIT_NOT_FOUND" }, 404);

  const [after] = await sql`
    UPDATE units SET
      status = COALESCE(${status ?? null}, status),
      available_from = CASE WHEN ${hasDate} THEN ${available_from || null} ELSE available_from END,
      rent_override = CASE WHEN ${hasRent} THEN ${rent_override === "" ? null : rent_override} ELSE rent_override END,
      notes = CASE WHEN ${hasNotes} THEN ${notes || null} ELSE notes END,
      updated_at = now()
    WHERE unit_number = ${unit} RETURNING *`;

  await audit(c, { action: "unit.update", entityType: "unit", entityId: unit,
    before: { status: before.status, available_from: before.available_from },
    after: { status: after.status, available_from: after.available_from } });

  return c.json({ unit: after });
});

/* ---------- Pricing ---------- */

r.get("/pricing", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const [profile] = await sql`
    SELECT * FROM pricing_profiles
    WHERE effective_from <= CURRENT_DATE
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY effective_from DESC LIMIT 1`;
  if (!profile) return c.json({ profile: null, rents: [], fees: null });

  const rents = await sql`
    SELECT r.*, t.bedroom_label_en, t.area_sqft
    FROM unit_type_rents r JOIN unit_types t ON t.code = r.unit_type_code
    WHERE r.pricing_profile_id = ${profile.id} ORDER BY t.area_sqft`;
  const [fees] = await sql`SELECT * FROM fee_settings
    WHERE pricing_profile_id = ${profile.id}`;

  return c.json({
    profile,
    // Rent per square foot, worked out here rather than typed. It is the
    // number people compare between suites, and two people calculating it by
    // hand produce two answers.
    rents: rents.map((x) => ({ ...x,
      per_sqft: x.area_sqft ? Number((x.base_rent / x.area_sqft).toFixed(2)) : null })),
    fees: fees ?? null,
  });
});

/** A new price list opens from a date rather than editing the current one.
 *  Editing in place would restate what somebody was already quoted, and the
 *  fee disclosure a tenant confirmed at application would silently stop
 *  matching what they were shown. */
r.post("/pricing", require_("settings.pricing.edit"), async (c) => {
  const sql = c.get("db");
  const { name, effective_from, rents, fees, note } = await c.req.json();
  if (!effective_from) return c.json({ code: "DATE_REQUIRED" }, 400);

  const out = await sql.begin(async (tx) => {
    const [current] = await tx`SELECT * FROM pricing_profiles
      WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`;
    if (current)
      await tx`UPDATE pricing_profiles
        SET effective_to = (${effective_from}::date - INTERVAL '1 day')
        WHERE id = ${current.id}`;

    const [profile] = await tx`
      INSERT INTO pricing_profiles (id, name, effective_from, created_by)
      VALUES (${uid('pp_')}, ${name?.trim() || note?.trim() || `Pricing ${effective_from}`},
              ${effective_from}, ${c.get("user").id})
      RETURNING *`;

    for (const x of rents ?? [])
      await tx`INSERT INTO unit_type_rents (id, pricing_profile_id, unit_type_code, base_rent)
        VALUES (${uid('utr_')}, ${profile.id},
                ${x.unit_type_code}, ${x.base_rent})`;

    if (fees)
      await tx`INSERT INTO fee_settings (id, pricing_profile_id, parking_underground,
        parking_surface, storage_fee, cat_deposit, dog_deposit, pet_rent, pet_limit,
        application_fee, utilities_included)
        VALUES (${uid('fs_')}, ${profile.id},
                ${fees.parking_underground ?? null}, ${fees.parking_surface ?? null},
                ${fees.storage_fee ?? null},
                ${fees.cat_deposit ?? fees.pet_deposit ?? null},
                ${fees.dog_deposit ?? fees.pet_deposit ?? null},
                ${fees.pet_rent ?? null}, ${fees.pet_limit ?? null},
                ${fees.application_fee ?? null}, ${fees.utilities_included ?? null})`;

    return { profile, superseded: current?.id ?? null };
  });

  await audit(c, { action: "pricing.create", entityType: "pricing_profile",
    entityId: out.profile.id, after: { effective_from, rents: rents?.length ?? 0 } });

  return c.json(out, 201);
});

/* ---------- Address for legal service ----------

   Email is not automatically an address for service merely because it is on
   a contact record. This separate confirmation is what the legal-notice
   routes check before they allow electronic service. */
r.post("/contacts/:id/service-address", require_("lease.sign"), async (c) => {
  const { email, confirmation_source } = await c.req.json().catch(() => ({}));
  const value = String(email ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(value) || !String(confirmation_source ?? "").trim())
    return c.json({ code: "EMAIL_AND_CONFIRMATION_SOURCE_REQUIRED" }, 400);

  const sql = c.get("db");
  const [before] = await sql`SELECT id, email, electronic_service_email,
    electronic_service_confirmed_at FROM contacts WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "CONTACT_NOT_FOUND" }, 404);

  const [after] = await sql`UPDATE contacts
    SET electronic_service_email = ${value},
        electronic_service_confirmed_at = now(),
        electronic_service_source = ${String(confirmation_source).trim().slice(0, 500)}
    WHERE id = ${before.id}
    RETURNING id, electronic_service_email, electronic_service_confirmed_at,
              electronic_service_source`;

  await audit(c, { action: "contact.service_address.confirm",
    entityType: "contact", entityId: before.id, before, after });
  return c.json({ contact: after });
});

r.delete("/contacts/:id/service-address", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const [before] = await sql`SELECT id, electronic_service_email,
    electronic_service_confirmed_at FROM contacts WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "CONTACT_NOT_FOUND" }, 404);
  await sql`UPDATE contacts SET electronic_service_email = NULL,
    electronic_service_confirmed_at = NULL, electronic_service_source = NULL
    WHERE id = ${before.id}`;
  await audit(c, { action: "contact.service_address.remove",
    entityType: "contact", entityId: before.id, before, after: null });
  return c.json({ ok: true });
});

/* ---------- Parking ---------- */

r.get("/parking", require_("parking.view"), async (c) => {
  const sql = c.get("db");
  const pools = await sql`SELECT * FROM parking_pools ORDER BY code`;
  const allocations = await sql`
    SELECT * FROM parking_allocations WHERE status <> 'released'
    ORDER BY requested_at`;

  return c.json({
    pools: pools.map((p) => {
      const mine = allocations.filter((a) => a.pool_code === p.code);
      const assigned = mine.filter((a) => a.status === "assigned");
      const waiting = mine.filter((a) => a.status === "waiting");
      return { ...p, assigned: assigned.length,
        free: p.total_stalls - assigned.length, waiting: waiting.length,
        // Position matters to whoever is waiting, and it is the first thing
        // they ask. Working it out here means everyone sees the same number.
        waitlist: waiting.map((a, i) => ({ ...a, position: i + 1 })) };
    }),
    // 222 stalls against 330 units. Structural, not a policy, and the public
    // site says so — a tenant who finds out after signing has a reason to be
    // annoyed that one who was told does not.
    total_stalls: pools.reduce((t, p) => t + p.total_stalls, 0),
    total_units: 330,
  });
});

/**
 * Requesting a stall.
 *
 * The read and the write are in one transaction with the pool row locked.
 * Two people clicking at the same moment is what this is for: the first
 * locks the row, the second waits, then reads the pool as it now is and
 * finds nothing free.
 *
 * Without the lock both read "one free" and both get told yes, and the
 * building has one stall promised twice with nothing in the data to show
 * which promise came first.
 */
r.post("/parking/request", require_("parking.allocate"), async (c) => {
  const sql = c.get("db");
  const { pool_code, unit_number, contact_id } = await c.req.json();
  if (!pool_code || !unit_number)
    return c.json({ code: "MISSING_FIELDS" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [pool] = await tx`
        SELECT * FROM parking_pools WHERE code = ${pool_code} FOR UPDATE`;
      if (!pool) throw Object.assign(new Error("POOL_NOT_FOUND"), { status: 404 });

      // The unit has to exist. Without this a typo allocates a stall to a
      // suite that is not there, and it sits in the pool looking assigned.
      const [unitRow] = await tx`
        SELECT unit_number FROM units WHERE unit_number = ${unit_number}`;
      if (!unitRow)
        throw Object.assign(new Error("UNIT_NOT_FOUND"), { status: 404 });

      // The limit is a setting, not a parameter. Taken from the request it is
      // not a limit at all — anyone calling the API sends the number they
      // want. There are 222 stalls for 330 units, so this is the rule that
      // decides who goes without.
      const [{ count: held }] = await tx`
        SELECT COUNT(*)::int AS count FROM parking_allocations
        WHERE unit_number = ${unit_number} AND status IN ('assigned','waiting')`;
      if (held >= (pool.max_per_unit ?? 1))
        throw Object.assign(new Error("UNIT_AT_LIMIT"),
          { status: 409, held, max_per_unit: pool.max_per_unit ?? 1 });

      const [{ count: assigned }] = await tx`
        SELECT COUNT(*)::int AS count FROM parking_allocations
        WHERE pool_code = ${pool_code} AND status = 'assigned'`;

      const free = pool.total_stalls - assigned;
      const status = free > 0 ? "assigned" : "waiting";

      const [row] = await tx`
        INSERT INTO parking_allocations (id, pool_code, unit_number, contact_id,
          status, requested_at, assigned_at)
        VALUES (${uid('pa_')}, ${pool_code},
                ${unit_number}, ${contact_id ?? null}, ${status}, now(),
                ${status === "assigned" ? sql`now()` : null})
        RETURNING *`;

      let position = null;
      if (status === "waiting") {
        const [{ count }] = await tx`
          SELECT COUNT(*)::int AS count FROM parking_allocations
          WHERE pool_code = ${pool_code} AND status = 'waiting'
            AND requested_at <= ${row.requested_at}`;
        position = count;
      }

      return { allocation: row, status, free_before: free, waitlist_position: position };
    });

    await audit(c, { action: "parking.request", entityType: "unit", entityId: unit_number,
      after: { pool_code, status: out.status, position: out.waitlist_position } });

    return c.json(out, 201);
  } catch (e) {
    return c.json({ code: e.message, held: e.held, max_per_unit: e.max_per_unit },
                  e.status ?? 500);
  }
});

/**
 * Giving a stall up.
 *
 * The next person on the list gets it in the same transaction. Doing it in
 * two steps leaves a window where the stall is free and nobody has it, which
 * is exactly when somebody else's request arrives and jumps the queue.
 */
r.post("/parking/:id/release", require_("parking.allocate"), async (c) => {
  const sql = c.get("db");

  const out = await sql.begin(async (tx) => {
    const [alloc] = await tx`
      SELECT * FROM parking_allocations WHERE id = ${c.req.param("id")} FOR UPDATE`;
    if (!alloc) throw Object.assign(new Error("ALLOCATION_NOT_FOUND"), { status: 404 });

    await tx`UPDATE parking_allocations SET status = 'released', released_at = now()
      WHERE id = ${alloc.id}`;

    if (alloc.status !== "assigned") return { released: alloc.id, promoted: null };

    // First by request time. Not by rent paid, not by unit type — allocating
    // scarce parking on a discretionary basis is where a fair housing problem
    // starts, and first come is the only rule that explains itself.
    const [next] = await tx`
      SELECT * FROM parking_allocations
      WHERE pool_code = ${alloc.pool_code} AND status = 'waiting'
      ORDER BY requested_at LIMIT 1 FOR UPDATE`;

    if (!next) return { released: alloc.id, promoted: null };

    await tx`UPDATE parking_allocations SET status = 'assigned', assigned_at = now()
      WHERE id = ${next.id}`;
    return { released: alloc.id, promoted: next };
  });

  await audit(c, { action: "parking.release", entityType: "parking", entityId: out.released,
    after: { promoted: out.promoted?.unit_number ?? null } });

  return c.json(out);
});


export default r;
