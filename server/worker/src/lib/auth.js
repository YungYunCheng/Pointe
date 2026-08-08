/* ============================================================
   Guards and the audit write

   Separate from index.js so routes can import them without
   importing the app. A route that imports the app and the app that
   imports the route is a cycle, and the symptom is an undefined
   export at runtime rather than an error at build.
   ============================================================ */

/**
 * Requires a permission.
 *
 * Every staff route declares what it needs, so "who can do this" is answered
 * in the route rather than in a document that drifts from the code.
 */
export const require_ = (permission) => async (c, next) => {
  const user = c.get("user");
  if (!user?.perms?.has(permission))
    return c.json({ code: "FORBIDDEN", needs: permission }, 403);
  return next();
};

/**
 * The unit a tenant route may touch. From the session, never the request.
 *
 * A route that reads the unit from the URL is a route where changing a number
 * shows you somebody else's lease. Taking the parameter away means the
 * mistake cannot be written rather than being caught when somebody remembers
 * to check.
 */
export const tenantUnit = (c) => {
  const t = c.get("tenant");
  if (!t?.unit)
    throw Object.assign(new Error("NO_UNIT_ON_SESSION"), {
      status: 403, code: "NO_UNIT_ON_SESSION",
      detail: "This account is not attached to a suite." });
  return t.unit;
};

/**
 * For the few tenant routes that take an id — a repair, a document.
 *
 * Throws 404 rather than 403. Telling somebody a record exists but is not
 * theirs confirms it exists, which is worth something to whoever is trying
 * numbers.
 */
export function mustBeTheirs(c, row, column = "unit_number") {
  const unit = tenantUnit(c);
  if (!row || row[column] !== unit)
    throw Object.assign(new Error("NOT_FOUND"), { status: 404, code: "NOT_FOUND" });
  return row;
}

/**
 * Records who did what.
 *
 * Awaited inside the request rather than deferred. An audit entry written
 * after the process ends is an audit entry that does not exist, and the whole
 * point of the log is that it is there when somebody asks.
 */
export async function audit(c, { action, entityType, entityId, before, after }) {
  const user = c.get("user") ?? c.get("tenant");
  await c.get("db")`
    INSERT INTO audit_log (actor_user_id, actor_name, action, entity_type, entity_id,
      before_value, after_value, ip)
    VALUES (${user?.id ?? null}, ${user?.name ?? "system"}, ${action},
            ${entityType ?? null}, ${entityId ?? null},
            ${before ? JSON.stringify(before) : null},
            ${after ? JSON.stringify(after) : null},
            ${c.req.header("cf-connecting-ip") ?? null})`;
}

/** Ids in the shape the application already uses (usr_xxx, pa_xxx). Kept so
 *  the schema and the code stay consistent through the port. */
export const uid = (prefix) =>
  prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
