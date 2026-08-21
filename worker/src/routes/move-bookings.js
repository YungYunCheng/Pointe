import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";

const r = new Hono();
const DIRECTIONS = new Set(["move_in", "move_out"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const bookingRows = async (sql, accountId = null) => accountId
  ? sql`SELECT mb.*, ta.full_name AS tenant_name, ta.email AS tenant_email,
      b.address AS building_address
    FROM move_elevator_bookings mb
    JOIN tenant_accounts ta ON ta.id = mb.account_id
    JOIN buildings b ON b.code = mb.building_code
    WHERE mb.account_id = ${accountId}
    ORDER BY mb.move_date DESC, mb.time_from, mb.created_at DESC`
  : sql`SELECT mb.*, ta.full_name AS tenant_name, ta.email AS tenant_email,
      b.address AS building_address
    FROM move_elevator_bookings mb
    JOIN tenant_accounts ta ON ta.id = mb.account_id
    JOIN buildings b ON b.code = mb.building_code
    ORDER BY mb.move_date DESC, mb.time_from, mb.created_at DESC`;

r.get("/tenant/move-bookings", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ bookings: await bookingRows(c.get("db"), tenant.id) });
});

r.post("/tenant/move-bookings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tenant = c.get("tenant");
  if (!tenant?.unit) return c.json({ code: "TENANT_UNIT_REQUIRED" }, 400);
  if (!DIRECTIONS.has(body.direction) || !/^\d{4}-\d{2}-\d{2}$/.test(body.move_date || "") ||
      !TIME.test(body.time_from || "") || !TIME.test(body.time_to || ""))
    return c.json({ code: "MOVE_BOOKING_FIELDS_REQUIRED" }, 400);
  if (body.time_to <= body.time_from)
    return c.json({ code: "END_TIME_MUST_BE_LATER" }, 400);

  const sql = c.get("db");
  const [unit] = await sql`SELECT building_code FROM units WHERE unit_number = ${tenant.unit}`;
  if (!unit) return c.json({ code: "TENANT_UNIT_REQUIRED" }, 400);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton" }).format(new Date());
  if (body.move_date < today) return c.json({ code: "MOVE_DATE_IN_PAST" }, 400);

  const booking = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`move:${unit.building_code}:${body.move_date}`}))`;
    const [clash] = await tx`
      SELECT id FROM move_elevator_bookings
      WHERE building_code = ${unit.building_code} AND move_date = ${body.move_date}
        AND status IN ('requested','confirmed')
        AND time_from < ${body.time_to}::time AND time_to > ${body.time_from}::time
      LIMIT 1`;
    if (clash) return null;
    const [row] = await tx`
      INSERT INTO move_elevator_bookings (id, account_id, lease_id, unit_number,
        building_code, direction, move_date, time_from, time_to, notes)
      VALUES (${uid("mv_")}, ${tenant.id}, ${tenant.leaseId || null}, ${tenant.unit},
        ${unit.building_code}, ${body.direction}, ${body.move_date},
        ${body.time_from}, ${body.time_to}, ${String(body.notes || "").trim() || null})
      RETURNING *`;
    await tx`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'building_manager', 'move_booking',
        'MOVE_ELEVATOR_REQUESTED', ${JSON.stringify({ unit: tenant.unit,
          building: unit.building_code, direction: body.direction,
          date: body.move_date, from: body.time_from, to: body.time_to })}, '/schedule')`;
    const managers = await tx`SELECT email, full_name FROM users
      WHERE role_code = 'building_manager' AND is_active AND email IS NOT NULL`;
    for (const manager of managers)
      await tx`INSERT INTO outbox (id, channel, to_email, to_name, kind, subject,
          body, ref_type, ref_id)
        VALUES (${uid("ob_")}, 'email', ${manager.email}, ${manager.full_name},
          'move_elevator_requested', ${`Elevator request · ${tenant.unit}`},
          ${`${tenant.full_name || "A tenant"} requested the elevator for ${body.direction === "move_in" ? "move-in" : "move-out"} on ${body.move_date}, ${body.time_from}–${body.time_to}. Confirm or decline it in Schedule.`},
          'move_elevator_booking', ${row.id})`;
    return row;
  });
  if (!booking) return c.json({ code: "MOVE_SLOT_UNAVAILABLE" }, 409);
  return c.json({ booking }, 201);
});

r.patch("/tenant/move-bookings/:id/cancel", async (c) => {
  const tenant = c.get("tenant");
  const [booking] = await c.get("db")`
    UPDATE move_elevator_bookings SET status = 'cancelled', updated_at = now()
    WHERE id = ${c.req.param("id")} AND account_id = ${tenant.id}
      AND status = 'requested' RETURNING *`;
  if (!booking) return c.json({ code: "NOT_FOUND_OR_NOT_CANCELLABLE" }, 404);
  return c.json({ booking });
});

r.get("/move-bookings", require_("move_booking.view"), async (c) => {
  return c.json({ bookings: await bookingRows(c.get("db")) });
});

async function decide(c, status) {
  const user = c.get("user");
  if (user?.role !== "building_manager")
    return c.json({ code: "BUILDING_MANAGER_CONFIRMATION_REQUIRED" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const [before] = await sql`
    SELECT mb.*, ta.email AS tenant_email, ta.full_name AS tenant_name, ta.locale
    FROM move_elevator_bookings mb JOIN tenant_accounts ta ON ta.id = mb.account_id
    WHERE mb.id = ${c.req.param("id")}`;
  if (!before || before.status !== "requested")
    return c.json({ code: "NOT_FOUND_OR_ALREADY_DECIDED" }, 404);
  const [booking] = await sql.begin(async (tx) => {
    const [updated] = await tx`
      UPDATE move_elevator_bookings SET status = ${status}, confirmed_by = ${user.id},
        confirmed_name = ${user.name}, confirmed_at = now(),
        decision_note = ${String(body.note || "").trim() || null},
        tenant_notified_at = now(), updated_at = now()
      WHERE id = ${before.id} AND status = 'requested' RETURNING *`;
    if (!updated) return [];
    const confirmed = status === "confirmed";
    const subject = confirmed ? "Elevator booking confirmed" : "Elevator booking needs another time";
    const message = confirmed
      ? `Your ${before.direction === "move_in" ? "move-in" : "move-out"} elevator booking for ${before.move_date}, ${String(before.time_from).slice(0,5)}–${String(before.time_to).slice(0,5)} has been confirmed.`
      : `Your requested elevator time on ${before.move_date} was not available. Please sign in to the tenant portal and choose another time.${body.note ? ` ${String(body.note).trim()}` : ""}`;
    await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
        subject, body, ref_type, ref_id)
      VALUES (${uid("ob_")}, 'email', ${before.tenant_email}, ${before.tenant_name},
        ${before.locale || "en"}, 'move_elevator_decision', ${subject}, ${message},
        'move_elevator_booking', ${before.id})`;
    return [updated];
  });
  if (!booking) return c.json({ code: "ALREADY_DECIDED" }, 409);
  await audit(c, { action: `move_elevator.${status}`, entityType: "move_elevator_booking",
    entityId: before.id, before: { status: before.status },
    after: { status, confirmed_by: user.id } });
  return c.json({ booking });
}

r.post("/move-bookings/:id/confirm", require_("move_booking.confirm"), (c) => decide(c, "confirmed"));
r.post("/move-bookings/:id/decline", require_("move_booking.confirm"), (c) => decide(c, "declined"));

r.post("/move-bookings/:id/complete", require_("move_booking.confirm"), async (c) => {
  const user = c.get("user");
  if (user?.role !== "building_manager")
    return c.json({ code: "BUILDING_MANAGER_CONFIRMATION_REQUIRED" }, 403);
  const [booking] = await c.get("db")`
    UPDATE move_elevator_bookings SET status = 'completed', updated_at = now()
    WHERE id = ${c.req.param("id")} AND status = 'confirmed' RETURNING *`;
  if (!booking) return c.json({ code: "NOT_FOUND_OR_NOT_CONFIRMED" }, 404);
  await audit(c, { action: "move_elevator.completed", entityType: "move_elevator_booking",
    entityId: booking.id, after: { status: booking.status } });
  return c.json({ booking });
});

export default r;
