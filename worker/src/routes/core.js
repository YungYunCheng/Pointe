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

  return c.json({
    units: units.map((u) => ({ ...u, current_rent: rentBy[u.unit_type_code] ?? null })),
    counts: units.reduce((acc, u) => {
      acc[u.status] = (acc[u.status] ?? 0) + 1;
      return acc;
    }, {}),
  });
});

r.patch("/units/:unit", require_("units.status.edit"), async (c) => {
  const sql = c.get("db");
  const { status, available_from, rent_override, note } = await c.req.json();
  const unit = c.req.param("unit");

  const [before] = await sql`SELECT * FROM units WHERE unit_number = ${unit}`;
  if (!before) return c.json({ code: "UNIT_NOT_FOUND" }, 404);

  const [after] = await sql`
    UPDATE units SET
      status = COALESCE(${status ?? null}, status),
      available_from = COALESCE(${available_from ?? null}, available_from),
      rent_override = COALESCE(${rent_override ?? null}, rent_override),
      note = COALESCE(${note ?? null}, note),
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
