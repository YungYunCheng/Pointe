import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";
import { INCREASE_INTERVAL_DAYS, MAX_CHARGE_DAY } from "../lib/rules.js";

/* ============================================================
   Creating a tenancy

   The source of every date that matters afterwards.

   Commencement is what the agreement says. Not when it was
   signed, not when this row was entered, and not when somebody
   pressed send. A tenancy commencing 1 January and signed on the
   20th has its anniversary on 1 January, and every future rent
   increase runs from there.

   Getting it wrong here is not a single error. It moves every
   anniversary for the life of the tenancy, and nothing downstream
   can tell that it happened.
   ============================================================ */

const r = new Hono();

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) =>
  new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

r.post("/leases", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const b = await c.req.json();

  const { unit_number, contact_id, start_date, end_date, term_type = "fixed_12",
          rent, deposit, occupants, charge_day, signed_on, external_ref,
          extras, tenant } = b;

  if (!unit_number || !start_date || !rent)
    return c.json({ code: "MISSING_FIELDS",
      detail: "A tenancy needs a suite, a commencement date and a rent." }, 400);

  // A fixed term has an end; a periodic one does not. The two are mutually
  // exclusive and the database enforces it, but the message is better here.
  const fixedTerm = term_type !== "periodic";
  if (!["fixed", "fixed_6", "fixed_12", "periodic"].includes(term_type))
    return c.json({ code: "INVALID_TERM_TYPE" }, 400);
  if (fixedTerm && !end_date)
    return c.json({ code: "END_DATE_REQUIRED",
      detail: "A fixed term needs an end date. For no end date, make it periodic." }, 400);
  if (term_type === "periodic" && end_date)
    return c.json({ code: "PERIODIC_HAS_NO_END",
      detail: "A periodic tenancy has no end date." }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [unit] = await tx`SELECT * FROM units WHERE unit_number = ${unit_number}
        FOR UPDATE`;
      if (!unit) throw Object.assign(new Error("UNIT_NOT_FOUND"), { status: 404 });

      // Two tenancies on one suite is not a data problem, it is two families
      // with keys.
      const [existing] = await tx`
        SELECT id, start_date, end_date FROM leases
        WHERE unit_number = ${unit_number} AND status = 'active'
          AND (end_date IS NULL OR end_date >= ${start_date})`;
      if (existing)
        throw Object.assign(new Error("UNIT_ALREADY_LET"), { status: 409,
          detail: `${unit_number} has an active tenancy from ${existing.start_date}` +
                  `${existing.end_date ? ` to ${existing.end_date}` : " with no end date"}.` });

      let resolvedContactId = contact_id ?? null;
      if (!resolvedContactId) {
        const fullName = String(tenant?.full_name ?? "").trim();
        const email = String(tenant?.email ?? "").trim() || null;
        const phone = String(tenant?.phone ?? "").trim() || null;
        if (!fullName)
          throw Object.assign(new Error("TENANT_NAME_REQUIRED"), { status: 400 });

        let contact = null;
        if (email) {
          [contact] = await tx`
            SELECT ct.* FROM contacts ct
            WHERE lower(ct.email) = lower(${email})
              AND NOT EXISTS (
                SELECT 1 FROM leases existing
                WHERE existing.contact_id = ct.id AND existing.status = 'active'
              )
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
        }
        if (contact) {
          [contact] = await tx`
            UPDATE contacts SET full_name = ${fullName}, email = ${email},
              phone = COALESCE(${phone}, phone),
              normalised_email = lower(${email}),
              normalised_phone = ${phone ? phone.replace(/\D/g, "") : null}
            WHERE id = ${contact.id} RETURNING *`;
        } else {
          [contact] = await tx`
            INSERT INTO contacts (id, full_name, email, phone, locale,
              normalised_email, normalised_phone)
            VALUES (${uid("ct_")}, ${fullName}, ${email}, ${phone},
                    ${tenant?.locale ?? "en"}, ${email?.toLowerCase() ?? null},
                    ${phone ? phone.replace(/\D/g, "") : null})
            RETURNING *`;
        }
        resolvedContactId = contact.id;
      }

      const [lease] = await tx`
        INSERT INTO leases (id, unit_number, contact_id, start_date, end_date,
          term_type, rent, deposit, occupants, status, external_ref, created_by)
        VALUES (${uid("ls_")}, ${unit_number}, ${resolvedContactId},
                ${start_date}, ${end_date ?? null}, ${term_type},
                ${cents(rent)}, ${deposit == null ? null : cents(deposit)},
                ${occupants ?? null}, 'active', ${external_ref ?? null},
                ${c.get("user").id})
        RETURNING *`;

      /* last_increase_at stays NULL.
         
         The clock runs from commencement until the rent actually changes, and
         the eligibility view reads COALESCE(last_increase_at, start_date).
         Setting it to the start date here would look equivalent and is not:
         it would then be indistinguishable from a tenancy whose rent was
         raised on day one. */

      /* The rent schedule.
         
         The charge day is capped at 28 rather than taking the commencement
         day, because a tenancy starting on the 31st would silently skip
         February — and a month with no rent raised looks exactly like a month
         with no arrears. */
      const day = Math.min(charge_day ?? Number(start_date.slice(8, 10)) ?? 1, MAX_CHARGE_DAY);

      await tx`INSERT INTO charge_schedules (id, lease_id, unit_number, contact_id,
        kind, gl_code, amount, charge_day, due_day, start_date, end_date, is_active)
        VALUES (${uid("cs_")}, ${lease.id}, ${unit_number}, ${resolvedContactId},
                'rent', '4010', ${cents(rent)}, ${day}, ${day},
                ${start_date}, ${end_date ?? null}, TRUE)`;

      // Parking, storage, pet rent. Separate agreements with their own
      // figures, so a rent increase later does not move them.
      for (const x of extras ?? []) {
        if (!x.amount) continue;
        await tx`INSERT INTO charge_schedules (id, lease_id, unit_number, contact_id,
          kind, gl_code, amount, charge_day, due_day, start_date, end_date, is_active)
          VALUES (${uid("cs_")}, ${lease.id}, ${unit_number}, ${resolvedContactId},
                  ${x.kind}, ${x.gl_code ?? "4090"}, ${cents(x.amount)},
                  ${day}, ${day}, ${x.start_date ?? start_date},
                  ${end_date ?? null}, TRUE)`;
      }

      const unitStatus = start_date > today() ? "signed" : "occupied";
      await tx`UPDATE units SET status = ${unitStatus}, available_from = NULL, updated_at = now()
        WHERE unit_number = ${unit_number}`;

      return lease;
    });

    await audit(c, { action: "lease.create", entityType: "lease", entityId: out.id,
      after: { unit: unit_number, start: start_date, end: end_date, rent,
               // Recorded because it is a real fact worth having, and
               // separately from the commencement date so nothing later
               // confuses the two.
               signed_on: signed_on ?? null, by: c.get("user").name } });

    return c.json({ lease: out,
      note: signed_on && signed_on !== start_date
        ? `Commences ${start_date}, signed ${signed_on}. Every anniversary runs from ${start_date}.`
        : null }, 201);
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

/** Correcting a commencement date.
 *
 *  Its own endpoint rather than a general update, because changing it moves
 *  every anniversary for the life of the tenancy — and if the rent has
 *  already been increased once, it moves whether that increase was valid. */
r.patch("/leases/:id/commencement", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const { start_date, reason } = await c.req.json();
  if (!start_date || !reason?.trim())
    return c.json({ code: "DATE_AND_REASON_REQUIRED" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [lease] = await tx`SELECT * FROM leases WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!lease) throw Object.assign(new Error("LEASE_NOT_FOUND"), { status: 404 });

      const [increase] = await tx`SELECT * FROM rent_increases
        WHERE lease_id = ${lease.id} AND state IN ('served','applied')
        ORDER BY effective_on DESC LIMIT 1`;

      if (increase)
        throw Object.assign(new Error("INCREASE_ALREADY_SERVED"), { status: 409,
          detail: `A rent increase effective ${increase.effective_on} was calculated from the current commencement date of ${lease.start_date}. Changing it would move the anniversary that notice relied on, so whether it was valid would change with it. Withdraw the notice first.` });

      await tx`UPDATE leases SET start_date = ${start_date} WHERE id = ${lease.id}`;
      // The schedule follows, or the first month is raised against a date the
      // tenancy no longer has.
      await tx`UPDATE charge_schedules SET start_date = ${start_date}
        WHERE lease_id = ${lease.id} AND start_date = ${lease.start_date}`;

      return { was: lease.start_date, now: start_date };
    });

    await audit(c, { action: "lease.commencement", entityType: "lease",
      entityId: c.req.param("id"),
      before: { start_date: out.was }, after: { start_date: out.now, reason } });

    return c.json({ ok: true, ...out,
      note: "Every anniversary now runs from the new date." });
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

r.get("/leases/:id", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const [lease] = await sql`
    SELECT l.*, ct.full_name, ct.email, ct.locale,
           COALESCE(l.last_increase_at, l.start_date) AS anniversary_of,
           (COALESCE(l.last_increase_at, l.start_date) + ${INCREASE_INTERVAL_DAYS}) AS eligible_from
    FROM leases l LEFT JOIN contacts ct ON ct.id = l.contact_id
    WHERE l.id = ${c.req.param("id")}`;
  if (!lease) return c.json({ code: "NOT_FOUND" }, 404);

  return c.json({
    lease,
    schedules: await sql`SELECT * FROM charge_schedules WHERE lease_id = ${lease.id}
      ORDER BY kind`,
    increases: await sql`SELECT * FROM rent_increases WHERE lease_id = ${lease.id}
      ORDER BY effective_on DESC`,
    note: "Every anniversary runs from the commencement date on the agreement, not from when it was signed or entered.",
  });
});

/** Resident contact details shown in the unit register.  The lease remains
 * the assignment; editing the person's phone or email must not create a
 * second tenancy or silently move an account between suites. */
r.patch("/leases/:id/resident", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const b = await c.req.json().catch(() => ({}));
  const fullName = String(b.full_name ?? "").trim();
  if (!fullName) return c.json({ code: "TENANT_NAME_REQUIRED" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [lease] = await tx`
        SELECT * FROM leases WHERE id = ${c.req.param("id")} FOR UPDATE`;
      if (!lease) throw Object.assign(new Error("LEASE_NOT_FOUND"), { status: 404 });

      const email = String(b.email ?? "").trim() || null;
      const phone = String(b.phone ?? "").trim() || null;
      let contactId = lease.contact_id;
      let before = null;
      let contact;
      if (contactId) {
        [before] = await tx`SELECT * FROM contacts WHERE id = ${contactId} FOR UPDATE`;
        [contact] = await tx`
          UPDATE contacts SET full_name = ${fullName}, email = ${email}, phone = ${phone},
            normalised_email = ${email?.toLowerCase() ?? null},
            normalised_phone = ${phone ? phone.replace(/\D/g, "") : null}
          WHERE id = ${contactId} RETURNING *`;
      } else {
        [contact] = await tx`
          INSERT INTO contacts (id, full_name, email, phone, locale,
            normalised_email, normalised_phone)
          VALUES (${uid("ct_")}, ${fullName}, ${email}, ${phone}, ${b.locale ?? "en"},
                  ${email?.toLowerCase() ?? null},
                  ${phone ? phone.replace(/\D/g, "") : null}) RETURNING *`;
        contactId = contact.id;
        await tx`UPDATE leases SET contact_id = ${contactId} WHERE id = ${lease.id}`;
      }
      const [updatedLease] = await tx`
        UPDATE leases SET occupants = ${b.occupants === "" || b.occupants == null
          ? null : Number(b.occupants)} WHERE id = ${lease.id} RETURNING *`;
      return { lease: updatedLease, contact, before };
    });

    await audit(c, { action: "lease.resident.update", entityType: "lease",
      entityId: out.lease.id,
      before: out.before ? { name: out.before.full_name, email: out.before.email,
        phone: out.before.phone } : null,
      after: { name: out.contact.full_name, email: out.contact.email,
        phone: out.contact.phone, occupants: out.lease.occupants } });
    return c.json({ lease: out.lease, contact: out.contact });
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

export default r;
