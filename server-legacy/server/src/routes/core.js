import { Router } from "express";
import { db, uid, nowISO, txn } from "../db.js";
import { authenticate, require_, audit } from "../rbac.js";

const r = Router();
r.use(authenticate);

const LOCK_TTL_MIN = 120;

/* ================= Units ================= */

r.get("/units", require_("units.view"), (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, t.bedroom_label_en, t.bedroom_label_zh, t.area_sqft, t.balcony_sqft,
           COALESCE(u.rent_override, r.base_rent) AS rent
    FROM units u
    JOIN unit_types t ON t.code = u.unit_type_code
    LEFT JOIN pricing_profiles p
      ON p.effective_from <= date('now') AND (p.effective_to IS NULL OR p.effective_to >= date('now'))
    LEFT JOIN unit_type_rents r
      ON r.pricing_profile_id = p.id AND r.unit_type_code = u.unit_type_code
    ORDER BY u.unit_number
  `).all();
  res.json({ units: rows, available: rows.filter((x) => x.status === "available").length });
});

r.patch("/units/:unitNumber/status", require_("units.status.edit"), (req, res) => {
  const { status, available_from, notes } = req.body ?? {};
  const before = db.prepare("SELECT * FROM units WHERE unit_number = ?").get(req.params.unitNumber);
  if (!before) return res.status(404).json({ code: "UNIT_NOT_FOUND" });
  db.prepare(`UPDATE units SET status = COALESCE(?, status),
              available_from = COALESCE(?, available_from), notes = COALESCE(?, notes),
              updated_at = ? WHERE unit_number = ?`)
    .run(status ?? null, available_from ?? null, notes ?? null, nowISO(), req.params.unitNumber);
  const after = db.prepare("SELECT * FROM units WHERE unit_number = ?").get(req.params.unitNumber);
  audit(req, { action: "unit.status", entityType: "unit", entityId: req.params.unitNumber, before, after });
  res.json({ unit: after });
});

/* ================= Pricing ================= */
/* Every role reads the resulting numbers; only Admin publishes changes. */

r.get("/pricing", require_("units.view"), (req, res) => {
  const profile = db.prepare(`SELECT * FROM pricing_profiles
    WHERE effective_from <= date('now') AND (effective_to IS NULL OR effective_to >= date('now'))
    ORDER BY effective_from DESC LIMIT 1`).get();
  if (!profile) return res.json({ profile: null, rents: [], fees: null });
  res.json({
    profile,
    rents: db.prepare("SELECT * FROM unit_type_rents WHERE pricing_profile_id = ?").all(profile.id),
    fees: db.prepare("SELECT * FROM fee_settings WHERE pricing_profile_id = ?").get(profile.id) ?? null,
  });
});

/** Publishing a change closes the previous profile and opens a new one.
 *  History is never overwritten, so a past quote can always be explained. */
r.post("/pricing", require_("settings.pricing.edit"), (req, res) => {
  const { name, effective_from, rents = [], fees = {} } = req.body ?? {};
  if (!effective_from) return res.status(400).json({ code: "MISSING_EFFECTIVE_DATE" });

  const run = txn(() => {
    db.prepare(`UPDATE pricing_profiles SET effective_to = date(?, '-1 day')
                WHERE effective_to IS NULL`).run(effective_from);
    const pid = uid("pp_");
    db.prepare(`INSERT INTO pricing_profiles (id, name, effective_from, created_by)
                VALUES (?, ?, ?, ?)`).run(pid, name ?? effective_from, effective_from, req.user.id);
    const insR = db.prepare(`INSERT INTO unit_type_rents (id, pricing_profile_id, unit_type_code, base_rent)
                             VALUES (?, ?, ?, ?)`);
    for (const x of rents) insR.run(uid("r_"), pid, x.unit_type_code, Number(x.base_rent));
    db.prepare(`INSERT INTO fee_settings (id, pricing_profile_id, deposit_mode, deposit_fixed,
      cat_deposit, dog_deposit, pet_rent, pet_limit, parking_underground, parking_surface,
      storage_fee, application_fee, utilities_included)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid("fs_"), pid, fees.deposit_mode ?? "one_month", fees.deposit_fixed ?? null,
           fees.cat_deposit ?? null, fees.dog_deposit ?? null, fees.pet_rent ?? null,
           fees.pet_limit ?? null, fees.parking_underground ?? null, fees.parking_surface ?? null,
           fees.storage_fee ?? null, fees.application_fee ?? null, fees.utilities_included ?? null);
    return pid;
  });

  const pid = run();
  audit(req, { action: "pricing.publish", entityType: "pricing_profile", entityId: pid,
               after: { effective_from, rents, fees } });
  res.status(201).json({ profile_id: pid });
});

/* ================= Parking ================= */
/* Concurrency is handled by the transaction, not by application-level checks. */

r.get("/parking", require_("parking.view"), (req, res) => {
  const pools = db.prepare("SELECT * FROM parking_pools ORDER BY code").all();
  const counts = db.prepare(`SELECT pool_code, status, COUNT(*) n
                             FROM parking_allocations WHERE status <> 'released'
                             GROUP BY pool_code, status`).all();
  const byPool = {};
  for (const p of pools) byPool[p.code] = { ...p, assigned: 0, waiting: 0 };
  for (const c of counts) if (byPool[c.pool_code]) byPool[c.pool_code][c.status] = c.n;
  for (const k of Object.keys(byPool)) byPool[k].free = byPool[k].total_stalls - byPool[k].assigned;

  res.json({
    pools: Object.values(byPool),
    waitlist: db.prepare(`SELECT * FROM parking_allocations WHERE status='waiting'
                          ORDER BY requested_at`).all(),
    assigned: db.prepare(`SELECT * FROM parking_allocations WHERE status='assigned'
                          ORDER BY requested_at`).all(),
  });
});

r.patch("/parking/pools/:code", require_("settings.parking.quota"), (req, res) => {
  const before = db.prepare("SELECT * FROM parking_pools WHERE code = ?").get(req.params.code);
  if (!before) return res.status(404).json({ code: "POOL_NOT_FOUND" });
  const total = Number(req.body?.total_stalls);
  if (!Number.isFinite(total) || total < 0) return res.status(400).json({ code: "INVALID_STALL_COUNT" });

  const assigned = db.prepare(`SELECT COUNT(*) n FROM parking_allocations
                               WHERE pool_code=? AND status='assigned'`).get(req.params.code).n;
  if (total < assigned)
    return res.status(409).json({ code: "QUOTA_BELOW_ASSIGNED", assigned });

  db.prepare("UPDATE parking_pools SET total_stalls = ? WHERE code = ?").run(total, req.params.code);
  const after = db.prepare("SELECT * FROM parking_pools WHERE code = ?").get(req.params.code);
  audit(req, { action: "parking.quota", entityType: "parking_pool", entityId: req.params.code,
               before, after });
  res.json({ pool: after });
});

/**
 * First come, first served. Reading the balance and writing the allocation happen
 * inside one immediate transaction, so two simultaneous requests cannot both pass
 * the free-stall check.
 */
r.post("/parking/request", require_("parking.allocate"), (req, res) => {
  const { pool_code, unit_number, max_per_unit = 1 } = req.body ?? {};
  if (!pool_code || !unit_number) return res.status(400).json({ code: "MISSING_POOL_OR_UNIT" });

  try {
    const result = txn(() => {
      const pool = db.prepare("SELECT * FROM parking_pools WHERE code = ?").get(pool_code);
      if (!pool) throw Object.assign(new Error("POOL_NOT_FOUND"), { status: 404 });

      const held = db.prepare(`SELECT COUNT(*) n FROM parking_allocations
                               WHERE unit_number=? AND status<>'released'`).get(unit_number).n;
      if (held >= Number(max_per_unit))
        throw Object.assign(new Error("UNIT_STALL_LIMIT_REACHED"),
                            { status: 409, limit: Number(max_per_unit) });

      const assigned = db.prepare(`SELECT COUNT(*) n FROM parking_allocations
                                   WHERE pool_code=? AND status='assigned'`).get(pool_code).n;
      const free = pool.total_stalls - assigned;
      const status = free > 0 ? "assigned" : "waiting";
      const id = uid("pa_");
      db.prepare(`INSERT INTO parking_allocations
        (id, pool_code, unit_number, status, requested_at, assigned_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, pool_code, unit_number, status, nowISO(),
             status === "assigned" ? nowISO() : null, req.user.id);
      return { id, status, free_before: free };
    })();

    audit(req, { action: "parking.request", entityType: "parking_allocation",
                 entityId: result.id, after: { pool_code, unit_number, status: result.status } });
    res.status(201).json(result);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, limit: e.limit });
  }
});

/** Releasing a stall promotes the earliest waiting request in the same pool. */
r.post("/parking/:id/release", require_("parking.allocate"), (req, res) => {
  try {
    const out = txn(() => {
      const rec = db.prepare("SELECT * FROM parking_allocations WHERE id = ?").get(req.params.id);
      if (!rec) throw Object.assign(new Error("ALLOCATION_NOT_FOUND"), { status: 404 });
      if (rec.status === "released") throw Object.assign(new Error("ALREADY_RELEASED"), { status: 409 });

      db.prepare("UPDATE parking_allocations SET status='released', released_at=? WHERE id=?")
        .run(nowISO(), rec.id);

      let promoted = null;
      if (rec.status === "assigned") {
        promoted = db.prepare(`SELECT * FROM parking_allocations
                               WHERE pool_code=? AND status='waiting'
                               ORDER BY requested_at LIMIT 1`).get(rec.pool_code);
        if (promoted)
          db.prepare("UPDATE parking_allocations SET status='assigned', assigned_at=? WHERE id=?")
            .run(nowISO(), promoted.id);
      }
      return { released: rec.id, promoted: promoted?.unit_number ?? null };
    })();

    audit(req, { action: "parking.release", entityType: "parking_allocation",
                 entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message });
  }
});

/* ================= Signing lock ================= */
/* One row per unit number, so only one signing flow can exist at a time. */

r.get("/locks/:unitNumber", require_("units.view"), (req, res) => {
  const l = db.prepare("SELECT * FROM unit_locks WHERE unit_number = ?").get(req.params.unitNumber);
  if (!l || new Date(l.expires_at) < new Date()) return res.json({ lock: null });
  res.json({ lock: { ...l, mine: l.user_id === req.user.id } });
});

r.post("/locks/:unitNumber", require_("lease.sign"), (req, res) => {
  const unit = req.params.unitNumber;
  try {
    const out = txn(() => {
      db.prepare("DELETE FROM unit_locks WHERE expires_at < ?").run(nowISO());
      const cur = db.prepare("SELECT * FROM unit_locks WHERE unit_number = ?").get(unit);
      if (cur && cur.user_id !== req.user.id)
        throw Object.assign(new Error("UNIT_ALREADY_TAKEN"),
          { status: 409, holder: cur.user_name, since: cur.acquired_at });

      const u = db.prepare("SELECT * FROM units WHERE unit_number = ?").get(unit);
      if (!u) throw Object.assign(new Error("UNIT_NOT_FOUND"), { status: 404 });
      if (u.status !== "available" && !cur)
        throw Object.assign(new Error("UNIT_NOT_AVAILABLE"), { status: 409, status_now: u.status });

      const expires = new Date(Date.now() + LOCK_TTL_MIN * 60000).toISOString();
      db.prepare(`INSERT INTO unit_locks (unit_number, user_id, user_name, acquired_at, expires_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(unit_number) DO UPDATE SET expires_at = excluded.expires_at`)
        .run(unit, req.user.id, req.user.name, nowISO(), expires);
      return { unit_number: unit, expires_at: expires };
    })();

    audit(req, { action: "lock.acquire", entityType: "unit", entityId: unit, after: out });
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status ?? 500)
       .json({ code: e.message, holder: e.holder, since: e.since, status_now: e.status_now });
  }
});

r.delete("/locks/:unitNumber", require_("lease.sign"), (req, res) => {
  const cur = db.prepare("SELECT * FROM unit_locks WHERE unit_number = ?").get(req.params.unitNumber);
  if (!cur) return res.json({ ok: true });
  if (cur.user_id !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ code: "LOCK_NOT_YOURS" });
  db.prepare("DELETE FROM unit_locks WHERE unit_number = ?").run(req.params.unitNumber);
  audit(req, { action: "lock.release", entityType: "unit", entityId: req.params.unitNumber });
  res.json({ ok: true });
});

/* ================= Notifications ================= */

r.get("/notifications", require_("notifications.view"), (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications
    WHERE audience IN (?, ?) ORDER BY created_at DESC LIMIT 100`)
    .all(req.user.role, req.user.id)
    .map((n) => ({ ...n, params: n.params ? JSON.parse(n.params) : {} }));
  res.json({ notifications: rows, unread: rows.filter((n) => !n.read_at).length });
});

r.post("/notifications/:id/read", require_("notifications.view"), (req, res) => {
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(nowISO(), req.params.id);
  res.json({ ok: true });
});

export default r;
