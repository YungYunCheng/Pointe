import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";

/* Maintenance, vendor quotes, purchase orders and the future contract archive.
 * Every money-moving transition is explicit and permission-gated. */
const r = new Hono();
const MAX_FLOORPLAN_BYTES = 10 * 1024 * 1024;
const FLOORPLAN_TYPES = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["image/avif", "avif"],
]);
const safeFilename = (value, fallback = "floorplan") => {
  const name = String(value ?? "").split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || fallback;
};
const floorplanKey = (code) => `floorplans/${safeFilename(code)}/current`;

const amount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
};

const humanAssigner = (c) => {
  const user = c.get("user");
  return user?.role === "admin" || user?.role === "building_manager";
};

const activeBuildingManager = async (sql, requestedId = null) => {
  if (requestedId) {
    const [requested] = await sql`
      SELECT id, full_name FROM users
      WHERE id = ${requestedId} AND role_code = 'building_manager' AND is_active`;
    if (requested) return requested;
  }
  const [fallback] = await sql`
    SELECT id, full_name FROM users
    WHERE role_code = 'building_manager' AND is_active
    ORDER BY full_name, id LIMIT 1`;
  return fallback ?? null;
};

/* ---------- Shared staff schedule ---------- */
r.get("/events", require_("schedule.view"), async (c) => c.json({
  events: await c.get("db")`
    SELECT e.*, u.role_code AS assignee_role, COALESCE(e.assignee, u.full_name) AS owner_name
    FROM events e LEFT JOIN users u ON u.id = e.assignee_id
    ORDER BY e.starts_at`,
  staff: await c.get("db")`
    SELECT id, full_name, role_code FROM users WHERE is_active
    ORDER BY role_code, full_name`,
}));

r.post("/events", require_("schedule.view"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.type || !body.date || !body.time)
    return c.json({ code: "TYPE_DATE_TIME_REQUIRED" }, 400);
  const allowed = new Set(["showing", "signing", "keys", "maintenance", "followup", "review"]);
  if (!allowed.has(body.type)) return c.json({ code: "INVALID_EVENT_TYPE" }, 400);
  const user = c.get("user");
  if (body.type === "showing" && !["admin", "building_manager"].includes(user.role))
    return c.json({ code: "SHOWINGS_BUILDING_MANAGER_ONLY" }, 403);
  const sql = c.get("db");
  const assignee = body.type === "showing"
    ? await activeBuildingManager(sql, user.role === "admin" ? body.assignee_id : user.id)
    : (await sql`SELECT id, full_name FROM users
        WHERE id = ${user.role === "admin" && body.assignee_id ? body.assignee_id : user.id}
          AND is_active`)[0];
  if (!assignee) return c.json({ code: "ACTIVE_ASSIGNEE_REQUIRED" }, 400);
  const assigneeId = assignee.id;
  const [event] = await c.get("db")`
    INSERT INTO events (id, type, unit_number, contact_name, contact_info,
      assignee_id, assignee, starts_at, duration_min, blocking, state, created_via,
      signing_state)
    VALUES (${uid("ev_")}, ${body.type}, ${body.unit_number ?? null},
            ${body.contact_name ?? null}, ${body.contact_info ?? null},
            ${assigneeId}, ${assignee.full_name},
            ((${body.date}::date + ${body.time}::time) AT TIME ZONE 'America/Edmonton'),
            ${body.duration_min ?? 30}, ${body.type !== "maintenance"}, 'booked',
            'staff', ${body.type === "signing" ? "pending_review" : null})
    RETURNING *`;
  await audit(c, { action: "schedule.create", entityType: "event", entityId: event.id,
    after: { type: event.type, assignee_id: event.assignee_id, starts_at: event.starts_at } });
  return c.json({ event }, 201);
});

r.patch("/events/:id", require_("schedule.view"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const states = new Set(["booked", "done", "cancelled", "no_show"]);
  if (body.state && !states.has(body.state)) return c.json({ code: "INVALID_STATE" }, 400);
  const signing = new Set(["pending_review", "approved", "sent", "signed"]);
  if (body.signing_state && !signing.has(body.signing_state))
    return c.json({ code: "INVALID_SIGNING_STATE" }, 400);
  const user = c.get("user");
  const [existing] = await c.get("db")`SELECT type FROM events WHERE id = ${c.req.param("id")}`;
  if (!existing) return c.json({ code: "NOT_FOUND" }, 404);
  if (existing.type === "showing" && !["admin", "building_manager"].includes(user.role))
    return c.json({ code: "SHOWINGS_BUILDING_MANAGER_ONLY" }, 403);
  const [event] = await c.get("db")`
    UPDATE events SET
      state = COALESCE(${body.state ?? null}, state),
      outcome = COALESCE(${body.outcome ?? null}, outcome),
      signing_state = COALESCE(${body.signing_state ?? null}, signing_state),
      approved_by = CASE WHEN ${body.signing_state ?? null} = 'approved' THEN ${user.id} ELSE approved_by END,
      approved_name = CASE WHEN ${body.signing_state ?? null} = 'approved' THEN ${user.name} ELSE approved_name END,
      approved_at = CASE WHEN ${body.signing_state ?? null} = 'approved' THEN now() ELSE approved_at END,
      confirmation_state = COALESCE(${body.confirmation_state ?? null}, confirmation_state),
      confirmation_channel = COALESCE(${body.confirmation_channel ?? null}, confirmation_channel),
      confirmation_sent_at = CASE WHEN ${body.confirmation_state ?? null} = 'sent' THEN now() ELSE confirmation_sent_at END,
      confirmation_responded_at = CASE WHEN ${body.confirmation_state ?? null} IN ('confirmed','declined') THEN now() ELSE confirmation_responded_at END
    WHERE id = ${c.req.param("id")} RETURNING *`;
  if (!event) return c.json({ code: "NOT_FOUND" }, 404);
  await audit(c, { action: "schedule.update", entityType: "event", entityId: event.id,
    after: { state: event.state, signing_state: event.signing_state } });
  return c.json({ event });
});

/* One database round trip gives the screen a consistent snapshot. */
r.get("/maintenance", require_("maintenance.manage"), async (c) => {
  const [row] = await c.get("db")`
    SELECT json_build_object(
      'tickets', COALESCE((SELECT json_agg(x ORDER BY x.created_at DESC) FROM (
        SELECT m.*, u.building_code,
               rv.name AS recommended_vendor_name,
               av.name AS assigned_vendor_name
        FROM maintenance m
        JOIN units u ON u.unit_number = m.unit_number
        LEFT JOIN vendors rv ON rv.id = m.recommended_vendor_id
        LEFT JOIN vendors av ON av.id = m.assigned_vendor_id
      ) x), '[]'::json),
      'notes', COALESCE((SELECT json_agg(n ORDER BY n.at) FROM maintenance_notes n), '[]'::json),
      'quotes', COALESCE((SELECT json_agg(q ORDER BY q.created_at DESC) FROM vendor_quotes q), '[]'::json),
      'orders', COALESCE((SELECT json_agg(p ORDER BY p.created_at DESC) FROM purchase_orders p), '[]'::json),
      'order_lines', COALESCE((SELECT json_agg(l ORDER BY l.po_id, l.line_no) FROM purchase_order_lines l), '[]'::json),
      'vendors', COALESCE((SELECT json_agg(v ORDER BY v.name) FROM vendors v WHERE v.is_active), '[]'::json)
    ) AS data`;
  return c.json(row?.data ?? { tickets: [], notes: [], quotes: [], orders: [], order_lines: [], vendors: [] });
});

r.post("/maintenance", require_("maintenance.manage"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!String(body.unit_number ?? "").trim() || !String(body.description ?? "").trim())
    return c.json({ code: "UNIT_AND_DESCRIPTION_REQUIRED" }, 400);

  const id = uid("mt_");
  const [ticket] = await c.get("db")`
    INSERT INTO maintenance (id, unit_number, tenant_name, tenant_phone, category,
      priority, description, rush, approval_state)
    VALUES (${id}, ${String(body.unit_number).trim()}, ${body.tenant_name ?? null},
            ${body.tenant_phone ?? null}, ${body.category ?? "other"},
            ${body.priority ?? "normal"}, ${String(body.description).trim()},
            ${!!body.rush}, 'pending')
    RETURNING *`;
  await audit(c, { action: "maintenance.create", entityType: "maintenance", entityId: id,
    after: { unit_number: ticket.unit_number, category: ticket.category } });
  return c.json({ ticket }, 201);
});

r.patch("/maintenance/:id", require_("maintenance.manage"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const states = new Set(["new", "scheduled", "in_progress", "done", "cancelled"]);
  if (body.state != null && !states.has(body.state))
    return c.json({ code: "INVALID_STATE" }, 400);
  const sql = c.get("db");
  const [before] = await sql`SELECT * FROM maintenance WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const [ticket] = await sql`
    UPDATE maintenance SET
      category = COALESCE(${body.category ?? null}, category),
      priority = COALESCE(${body.priority ?? null}, priority),
      description = COALESCE(${body.description ?? null}, description),
      state = COALESCE(${body.state ?? null}, state),
      scheduled_at = COALESCE(${body.scheduled_at ?? null}, scheduled_at),
      completed_at = CASE WHEN ${body.state ?? null} = 'done' THEN now() ELSE completed_at END
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "maintenance.update", entityType: "maintenance", entityId: before.id,
    before: { state: before.state }, after: { state: ticket.state } });
  return c.json({ ticket });
});

r.post("/maintenance/:id/notes", require_("maintenance.manage"), async (c) => {
  const { body } = await c.req.json().catch(() => ({}));
  if (!String(body ?? "").trim()) return c.json({ code: "NOTE_REQUIRED" }, 400);
  const user = c.get("user");
  const [note] = await c.get("db")`
    INSERT INTO maintenance_notes (id, ticket_id, body, by_user, by_name)
    VALUES (${uid("mn_")}, ${c.req.param("id")}, ${String(body).trim()},
            ${user.id}, ${user.name}) RETURNING *`;
  return c.json({ note }, 201);
});

/* This is a recommendation, not an assignment.  It ranks configured coverage,
 * preferred vendors and recent workload.  A future model can replace the
 * scorer without changing the confirmation boundary below. */
r.post("/maintenance/:id/recommend-vendor", require_("maintenance.manage"), async (c) => {
  const sql = c.get("db");
  const [ticket] = await sql`
    SELECT m.*, u.building_code FROM maintenance m
    JOIN units u ON u.unit_number = m.unit_number
    WHERE m.id = ${c.req.param("id")}`;
  if (!ticket) return c.json({ code: "NOT_FOUND" }, 404);

  const [vendor] = await sql`
    WITH workload AS (
      SELECT assigned_vendor_id AS vendor_id,
             COUNT(*) FILTER (WHERE state NOT IN ('done','cancelled'))::int AS open_jobs
      FROM maintenance WHERE assigned_vendor_id IS NOT NULL GROUP BY assigned_vendor_id
    )
    SELECT v.*, COALESCE(c.preference, 0) AS preference,
           COALESCE(w.open_jobs, 0) AS open_jobs,
           CASE WHEN c.vendor_id IS NOT NULL THEN 100 ELSE 25 END
             + COALESCE(c.preference, 0) * 5 - COALESCE(w.open_jobs, 0) * 2 AS score
    FROM vendors v
    LEFT JOIN vendor_service_coverage c ON c.vendor_id = v.id
      AND lower(c.category) = lower(${ticket.category ?? "other"})
      AND (c.building_code IS NULL OR c.building_code = ${ticket.building_code})
      AND c.is_available
    LEFT JOIN workload w ON w.vendor_id = v.id
    WHERE v.is_active
    ORDER BY score DESC, v.name
    LIMIT 1`;
  if (!vendor) return c.json({ code: "NO_ACTIVE_VENDOR" }, 409);

  const reason = `${vendor.name} matches ${ticket.category ?? "other"} work for building ` +
    `${ticket.building_code}; preference ${vendor.preference}, open jobs ${vendor.open_jobs}.`;
  const [updated] = await sql`
    UPDATE maintenance SET recommended_vendor_id = ${vendor.id},
      recommendation_reason = ${reason}, recommendation_score = ${vendor.score}
    WHERE id = ${ticket.id} RETURNING *`;
  await audit(c, { action: "maintenance.vendor.recommend", entityType: "maintenance",
    entityId: ticket.id, after: { vendor_id: vendor.id, score: vendor.score } });
  return c.json({ recommendation: { vendor, reason, score: vendor.score }, ticket: updated });
});

r.post("/maintenance/:id/confirm-assignment", require_("maintenance.manage"), async (c) => {
  if (!humanAssigner(c)) return c.json({ code: "MANAGER_CONFIRMATION_REQUIRED" }, 403);
  const { vendor_id, note } = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const user = c.get("user");
  const out = await sql.begin(async (tx) => {
    const [ticket] = await tx`SELECT * FROM maintenance WHERE id = ${c.req.param("id")} FOR UPDATE`;
    if (!ticket) return null;
    const chosen = vendor_id ?? ticket.recommended_vendor_id;
    const [vendor] = chosen
      ? await tx`SELECT * FROM vendors WHERE id = ${chosen} AND is_active`
      : [null];
    if (!vendor) return { error: "ACTIVE_VENDOR_REQUIRED" };
    const source = chosen === ticket.recommended_vendor_id ? "system_recommendation" : "manual";
    const [updated] = await tx`
      UPDATE maintenance SET approval_state = 'approved', approved_by = ${user.id},
        approved_name = ${user.name}, approved_at = now(), approval_note = ${note ?? null},
        assigned_vendor_id = ${vendor.id}, vendor = ${vendor.name},
        assignment_source = ${source}, assigned_by = ${user.id},
        assigned_name = ${user.name}, assigned_at = now()
      WHERE id = ${ticket.id} RETURNING *`;
    return { ticket: updated, vendor };
  });
  if (!out) return c.json({ code: "NOT_FOUND" }, 404);
  if (out.error) return c.json({ code: out.error }, 400);
  await audit(c, { action: "maintenance.vendor.assign", entityType: "maintenance",
    entityId: out.ticket.id, after: { vendor_id: out.vendor.id, confirmed_by: user.name } });
  return c.json(out);
});

r.post("/maintenance/:id/reject", require_("maintenance.manage"), async (c) => {
  if (!humanAssigner(c)) return c.json({ code: "MANAGER_CONFIRMATION_REQUIRED" }, 403);
  const { note } = await c.req.json().catch(() => ({}));
  if (!String(note ?? "").trim()) return c.json({ code: "REASON_REQUIRED" }, 400);
  const user = c.get("user");
  const [ticket] = await c.get("db")`
    UPDATE maintenance SET approval_state = 'rejected', approval_note = ${String(note).trim()},
      approved_by = ${user.id}, approved_name = ${user.name}, approved_at = now(),
      state = 'cancelled'
    WHERE id = ${c.req.param("id")} RETURNING *`;
  if (!ticket) return c.json({ code: "NOT_FOUND" }, 404);
  await audit(c, { action: "maintenance.reject", entityType: "maintenance",
    entityId: ticket.id, after: { reason: note } });
  return c.json({ ticket });
});

r.post("/maintenance/:id/quotes", require_("po.create"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const quoted = amount(body.amount);
  if (!body.vendor_id || quoted == null || quoted <= 0)
    return c.json({ code: "VENDOR_AND_AMOUNT_REQUIRED" }, 400);
  const sql = c.get("db");
  const [ticket] = await sql`SELECT * FROM maintenance WHERE id = ${c.req.param("id")}`;
  if (!ticket) return c.json({ code: "NOT_FOUND" }, 404);
  if (ticket.approval_state !== "approved")
    return c.json({ code: "ASSIGNMENT_CONFIRMATION_REQUIRED" }, 409);
  const [vendor] = await sql`SELECT * FROM vendors WHERE id = ${body.vendor_id} AND is_active`;
  if (!vendor) return c.json({ code: "ACTIVE_VENDOR_REQUIRED" }, 400);
  const [quote] = await sql`
    INSERT INTO vendor_quotes (id, ticket_id, vendor_id, vendor_name, amount,
      received_on, valid_until, lead_time_days, scope, exclusions, filename,
      stored_key, notes, uploaded_by, state)
    VALUES (${uid("vq_")}, ${ticket.id}, ${vendor.id}, ${vendor.name}, ${quoted},
            COALESCE(${body.received_on ?? null}::date, CURRENT_DATE),
            ${body.valid_until ?? null}, ${body.lead_time_days ?? null},
            ${body.scope ?? ticket.description}, ${body.exclusions ?? null},
            ${body.filename ?? null}, ${body.stored_key ?? null}, ${body.notes ?? null},
            ${c.get("user").id}, 'received') RETURNING *`;
  await audit(c, { action: "vendor_quote.receive", entityType: "vendor_quote",
    entityId: quote.id, after: { ticket_id: ticket.id, amount: quoted } });
  return c.json({ quote }, 201);
});

/* Selecting a quote creates the PO draft atomically.  If either write fails,
 * neither survives, so a selected quote can never be left without its PO. */
r.post("/vendor-quotes/:id/select", require_("po.create"), async (c) => {
  const user = c.get("user");
  const sql = c.get("db");
  const out = await sql.begin(async (tx) => {
    const [quote] = await tx`SELECT * FROM vendor_quotes WHERE id = ${c.req.param("id")} FOR UPDATE`;
    if (!quote) return null;
    if (quote.po_id) {
      const [existing] = await tx`SELECT * FROM purchase_orders WHERE id = ${quote.po_id}`;
      return { quote, order: existing, repeated: true };
    }
    const [ticket] = await tx`
      SELECT m.*, u.building_code FROM maintenance m
      JOIN units u ON u.unit_number = m.unit_number
      WHERE m.id = ${quote.ticket_id} FOR UPDATE OF m`;
    if (!ticket || ticket.approval_state !== "approved")
      return { error: "ASSIGNMENT_CONFIRMATION_REQUIRED" };

    const poId = uid("po_");
    const poNumber = `PO-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const [order] = await tx`
      INSERT INTO purchase_orders (id, po_number, ticket_id, quote_id, vendor_id,
        vendor_name, unit_number, building_code, description, scope, gl_code,
        estimated, drafted_by_ai, state, created_by, created_name)
      VALUES (${poId}, ${poNumber}, ${ticket.id}, ${quote.id}, ${quote.vendor_id},
              ${quote.vendor_name}, ${ticket.unit_number}, ${ticket.building_code},
              ${ticket.description}, ${quote.scope ?? ticket.description}, '5010',
              ${quote.amount}, TRUE, 'draft', ${user.id}, ${user.name}) RETURNING *`;
    await tx`
      INSERT INTO purchase_order_lines (id, po_id, line_no, description, gl_code,
        quantity, unit_price, estimated)
      VALUES (${uid("pol_")}, ${poId}, 1, ${quote.scope ?? ticket.description},
              '5010', 1, ${quote.amount}, ${quote.amount})`;
    await tx`UPDATE vendor_quotes SET state = 'rejected'
      WHERE ticket_id = ${ticket.id} AND id <> ${quote.id} AND state = 'received'`;
    const [selected] = await tx`
      UPDATE vendor_quotes SET state = 'selected', po_id = ${poId},
        selected_by = ${user.id}, selected_name = ${user.name}, selected_at = now()
      WHERE id = ${quote.id} RETURNING *`;
    return { quote: selected, order };
  });
  if (!out) return c.json({ code: "NOT_FOUND" }, 404);
  if (out.error) return c.json({ code: out.error }, 409);
  await audit(c, { action: "vendor_quote.select", entityType: "purchase_order",
    entityId: out.order.id, after: { quote_id: out.quote.id, amount: out.quote.amount } });
  return c.json(out, out.repeated ? 200 : 201);
});

r.post("/purchase-orders/:id/issue", require_("po.create"), async (c) => {
  const user = c.get("user");
  const [order] = await c.get("db")`
    UPDATE purchase_orders SET state = 'issued', issued_by = ${user.id},
      issued_name = ${user.name}, issued_at = now()
    WHERE id = ${c.req.param("id")} AND state = 'draft' RETURNING *`;
  if (!order) return c.json({ code: "ORDER_NOT_DRAFT" }, 409);
  await audit(c, { action: "purchase_order.issue", entityType: "purchase_order",
    entityId: order.id, after: { state: order.state } });
  return c.json({ order });
});

r.post("/purchase-orders/:id/work-done", require_("po.confirm"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actual = amount(body.actual_amount);
  if (actual == null || actual <= 0) return c.json({ code: "ACTUAL_AMOUNT_REQUIRED" }, 400);
  const sql = c.get("db");
  const [before] = await sql`SELECT * FROM purchase_orders WHERE id = ${c.req.param("id")}`;
  if (!before || before.state !== "issued") return c.json({ code: "ORDER_NOT_ISSUED" }, 409);
  if (actual !== Number(before.estimated) && !String(body.variance_note ?? "").trim())
    return c.json({ code: "VARIANCE_NOTE_REQUIRED" }, 400);
  const user = c.get("user");
  const [order] = await sql`
    UPDATE purchase_orders SET state = 'work_done', actual_amount = ${actual},
      variance_note = ${body.variance_note ?? null}, confirmed_by = ${user.id},
      confirmed_name = ${user.name}, confirmed_at = now()
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "purchase_order.work_done", entityType: "purchase_order",
    entityId: order.id, after: { actual_amount: actual } });
  return c.json({ order });
});

r.post("/purchase-orders/:id/bill", require_("po.bill"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sql = c.get("db");
  const user = c.get("user");
  const out = await sql.begin(async (tx) => {
    const [order] = await tx`SELECT * FROM purchase_orders WHERE id = ${c.req.param("id")} FOR UPDATE`;
    if (!order) return null;
    if (order.bill_id) {
      const [bill] = await tx`SELECT * FROM ap_invoices WHERE id = ${order.bill_id}`;
      return { order, bill, repeated: true };
    }
    if (order.state !== "work_done" || order.actual_amount == null)
      return { error: "WORK_CONFIRMATION_REQUIRED" };
    const billId = uid("api_");
    const invoiceNo = String(body.invoice_no ?? order.po_number).trim();
    const invoiceDate = body.invoice_date ?? new Date().toISOString().slice(0, 10);
    const dueDate = body.due_date ?? invoiceDate;
    const [bill] = await tx`
      INSERT INTO ap_invoices (id, vendor_id, invoice_no, invoice_date, due_date,
        building_code, unit_number, subtotal, gst, total, description, ticket_id,
        state, paid_amount, created_by)
      VALUES (${billId}, ${order.vendor_id}, ${invoiceNo}, ${invoiceDate}, ${dueDate},
              ${order.building_code}, ${order.unit_number}, ${order.actual_amount},
              0, ${order.actual_amount}, ${`${order.description} (${order.po_number})`},
              ${order.ticket_id}, 'draft', 0, ${user.id}) RETURNING *`;
    const lines = await tx`SELECT * FROM purchase_order_lines WHERE po_id = ${order.id} ORDER BY line_no`;
    if (lines.length) {
      for (const line of lines) await tx`
        INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code, description,
          amount, building_code, unit_number)
        VALUES (${uid("apl_")}, ${billId}, ${line.line_no}, ${line.gl_code ?? order.gl_code ?? "5010"},
                ${line.description}, ${line.actual ?? line.estimated},
                ${order.building_code}, ${order.unit_number})`;
    } else {
      await tx`INSERT INTO ap_invoice_lines (id, invoice_id, line_no, gl_code,
        description, amount, building_code, unit_number)
        VALUES (${uid("apl_")}, ${billId}, 1, ${order.gl_code ?? "5010"},
                ${order.description}, ${order.actual_amount}, ${order.building_code},
                ${order.unit_number})`;
    }
    const [updated] = await tx`
      UPDATE purchase_orders SET state = 'billed', bill_id = ${billId}
      WHERE id = ${order.id} RETURNING *`;
    return { order: updated, bill };
  });
  if (!out) return c.json({ code: "NOT_FOUND" }, 404);
  if (out.error) return c.json({ code: out.error }, 409);
  await audit(c, { action: "purchase_order.bill", entityType: "ap_invoice",
    entityId: out.bill.id, after: { po_id: out.order.id, state: "draft" } });
  return c.json(out, out.repeated ? 200 : 201);
});

/* Floor-plan management. Raw tour packages remain on the future company
 * server; this endpoint never accepts a file it cannot safely store. */
r.get("/unit-types", require_("units.view"), async (c) => {
  const rows = await c.get("db")`SELECT * FROM unit_types ORDER BY area_sqft, code`;
  const unitTypes = await Promise.all(rows.map(async (row) => {
    const object = c.env.FILES ? await c.env.FILES.head(floorplanKey(row.code)) : null;
    return { ...row, has_floorplan_image: !!object,
      floorplan_updated_at: object?.customMetadata?.uploaded_at ?? null,
      floorplan_image_url: `/api/public/floorplan-images/${encodeURIComponent(row.code)}` };
  }));
  return c.json({ unit_types: unitTypes });
});

r.patch("/unit-types/:code/virtual-tour", require_("floorplans.manage"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url = String(body.virtual_tour_url ?? "").trim();
  if (url && !/^https:\/\//i.test(url)) return c.json({ code: "HTTPS_TOUR_URL_REQUIRED" }, 400);
  const user = c.get("user");
  const [unitType] = await c.get("db")`
    UPDATE unit_types SET virtual_tour_url = ${url || null},
      virtual_tour_provider = ${body.virtual_tour_provider ?? null},
      virtual_tour_storage_key = ${body.virtual_tour_storage_key ?? null},
      virtual_tour_updated_by = ${user.id}, virtual_tour_updated_at = now()
    WHERE code = ${decodeURIComponent(c.req.param("code"))} RETURNING *`;
  if (!unitType) return c.json({ code: "NOT_FOUND" }, 404);
  await audit(c, { action: "floorplan.virtual_tour.update", entityType: "unit_type",
    entityId: unitType.code, after: { provider: unitType.virtual_tour_provider,
      has_url: !!unitType.virtual_tour_url, has_storage_key: !!unitType.virtual_tour_storage_key } });
  return c.json({ unit_type: unitType });
});

r.post("/unit-types/:code/floorplan-image", require_("floorplans.manage"), async (c) => {
  if (!c.env.FILES) return c.json({ code: "FILE_STORAGE_NOT_CONFIGURED" }, 503);
  const code = decodeURIComponent(c.req.param("code"));
  const sql = c.get("db");
  const [existing] = await sql`SELECT code FROM unit_types WHERE code = ${code}`;
  if (!existing) return c.json({ code: "NOT_FOUND" }, 404);
  const body = await c.req.parseBody().catch(() => ({}));
  const file = body.file;
  if (!file || typeof file.arrayBuffer !== "function")
    return c.json({ code: "FILE_REQUIRED" }, 400);
  if (!FLOORPLAN_TYPES.has(file.type))
    return c.json({ code: "IMAGE_TYPE_NOT_ALLOWED" }, 415);
  if (file.size <= 0 || file.size > MAX_FLOORPLAN_BYTES)
    return c.json({ code: "IMAGE_SIZE_NOT_ALLOWED", max_bytes: MAX_FLOORPLAN_BYTES }, 413);

  const user = c.get("user");
  const filename = safeFilename(file.name, `floorplan.${FLOORPLAN_TYPES.get(file.type)}`);
  const key = floorplanKey(code);
  await c.env.FILES.put(key, new Uint8Array(await file.arrayBuffer()), {
    httpMetadata: { contentType: file.type },
    customMetadata: { unit_type_code: code, uploaded_by: user.id, filename,
      uploaded_at: new Date().toISOString() },
  });
  await audit(c, { action: "floorplan.image.upload", entityType: "unit_type",
    entityId: code, after: { filename, size_bytes: file.size } });
  return c.json({ image_url: `/api/public/floorplan-images/${encodeURIComponent(code)}` }, 201);
});

r.delete("/unit-types/:code/floorplan-image", require_("floorplans.manage"), async (c) => {
  const code = decodeURIComponent(c.req.param("code"));
  const sql = c.get("db");
  const [existing] = await sql`SELECT code FROM unit_types WHERE code = ${code}`;
  if (!existing) return c.json({ code: "NOT_FOUND" }, 404);
  if (c.env.FILES) await c.env.FILES.delete(floorplanKey(code)).catch(() => {});
  await audit(c, { action: "floorplan.image.delete", entityType: "unit_type", entityId: code });
  return c.json({ ok: true });
});

/* Queues a completed signed document.  Until a connector is configured the
 * archive truthfully stays awaiting_connection and no delivery job is run. */
r.get("/contracts/archive", require_("contracts.archive"), async (c) => c.json({
  archives: await c.get("db")`
    SELECT a.*, sr.reference FROM signed_contract_archives a
    JOIN signature_requests sr ON sr.id = a.signature_request_id
    ORDER BY a.queued_at DESC`,
}));

r.post("/contracts/:requestId/archive", require_("contracts.archive"), async (c) => {
  const sql = c.get("db");
  const user = c.get("user");
  const out = await sql.begin(async (tx) => {
    const [request] = await tx`
      SELECT * FROM signature_requests WHERE id = ${c.req.param("requestId")} FOR UPDATE`;
    if (!request) return null;
    if (!request.signed_key || !request.signed_sha256 ||
        !["signed", "completed"].includes(request.state))
      return { error: "SIGNED_DOCUMENT_REQUIRED" };
    const [existing] = await tx`
      SELECT * FROM signed_contract_archives WHERE signature_request_id = ${request.id}`;
    if (existing) return { archive: existing, repeated: true };
    const archiveId = uid("sca_");
    const [archive] = await tx`
      INSERT INTO signed_contract_archives (id, signature_request_id, lease_id,
        unit_number, source_key, source_sha256, certificate_key, state,
        queued_by, queued_name)
      VALUES (${archiveId}, ${request.id}, ${request.lease_id}, ${request.unit_number},
              ${request.signed_key}, ${request.signed_sha256}, ${request.certificate_key},
              'awaiting_connection', ${user.id}, ${user.name}) RETURNING *`;
    await tx`INSERT INTO contract_storage_jobs (id, archive_id, state)
      VALUES (${uid("csj_")}, ${archiveId}, 'waiting')`;
    return { archive };
  });
  if (!out) return c.json({ code: "NOT_FOUND" }, 404);
  if (out.error) return c.json({ code: out.error }, 409);
  await audit(c, { action: "contract.archive.queue", entityType: "signed_contract_archive",
    entityId: out.archive.id, after: { state: out.archive.state } });
  return c.json(out, out.repeated ? 200 : 201);
});

export default r;
