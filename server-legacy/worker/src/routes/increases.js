import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";
import { INCREASE_INTERVAL_DAYS, INCREASE_NOTICE_DAYS, DEEMED_SERVICE_DAYS, NEEDS_PROOF_OF_SERVICE } from "../lib/rules.js";
import { sha256 } from "../lib/crypto.js";

/* ============================================================
   Rent increases

   Every tenancy has its own clock. The 365 days run from that
   tenant's last increase, or from the day their tenancy started
   — not from a date the landlord picks, and 330 suites signed
   across three years have 330 different anniversaries.

   So there is no batch. There is a policy, and each tenancy
   reaches its own date and gets its own notice.

   Alberta has no rent control, so nothing caps the amount. What
   is absolute is the timing and the notice, and getting either
   wrong does not make the increase smaller — it removes it. The
   rent stays where it was until a fresh notice has run its full
   period, which on a periodic tenancy is another three months.
   ============================================================ */

const r = new Hono();

/* Legal figures. Named because they are the law rather than a preference, and
   every one should be confirmed before the first notice goes out. */
/* The interval runs between the dates written on the agreements — the
   commencement date, or the effective date of the last increase. Not the
   signing date, not when the row was entered, and not when somebody pressed
   send. A tenancy commencing 1 January and signed on the 20th has its
   anniversary on 1 January, and using the later date gives away nineteen days
   of every future increase. */

/* Alberta's service rules decide when something counts as received, and the
   notice period runs from that date rather than from the day it was sent. */

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) =>
  new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(Number(n ?? 0));

function round(amount, mode) {
  if (mode === "nearest_5") return Math.round(amount / 5) * 5;
  if (mode === "nearest_10") return Math.round(amount / 10) * 10;
  return cents(amount);
}

/* ---------- The policy ---------- */

r.get("/increase-policies", require_("units.view"), async (c) => {
  const sql = c.get("db");
  return c.json({
    policies: await sql`SELECT * FROM rent_increase_policies
      ORDER BY effective_from DESC`,
    current: await sql`SELECT * FROM rent_increase_policies
      WHERE is_active AND effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC LIMIT 1`,
    rules: {
      interval_days: INCREASE_INTERVAL_DAYS,
      notice_days: INCREASE_NOTICE_DAYS,
      deemed_service: DEEMED_SERVICE_DAYS,
      note: "Alberta has no cap on the amount. The timing and the notice are absolute, and getting either wrong voids the increase rather than reducing it.",
    },
  });
});

/** A new policy opens from a date rather than editing the current one. A
 *  notice already served was calculated under the rule that existed then. */
r.post("/increase-policies", require_("settings.pricing.edit"), async (c) => {
  const sql = c.get("db");
  const { label, method, percent, fixed_amount, rounding, max_percent,
          max_amount, effective_from, note } = await c.req.json();

  if (!method || !effective_from)
    return c.json({ code: "MISSING_FIELDS" }, 400);

  const out = await sql.begin(async (tx) => {
    await tx`UPDATE rent_increase_policies
      SET effective_to = (${effective_from}::date - INTERVAL '1 day')
      WHERE is_active AND effective_to IS NULL`;

    const [p] = await tx`
      INSERT INTO rent_increase_policies (id, label, method, percent, fixed_amount,
        rounding, max_percent, max_amount, effective_from, note, created_by, created_name)
      VALUES (${uid("rip_")}, ${label ?? "Rent increase policy"}, ${method},
              ${percent ?? null}, ${fixed_amount ?? null}, ${rounding ?? "none"},
              ${max_percent ?? null}, ${max_amount ?? null}, ${effective_from},
              ${note ?? null}, ${c.get("user").id}, ${c.get("user").name})
      RETURNING *`;
    return p;
  });

  await audit(c, { action: "increase_policy.create",
    entityType: "rent_increase_policy", entityId: out.id,
    after: { method, percent, effective_from } });
  return c.json({ policy: out }, 201);
});

/* ---------- Who is due, and when ---------- */

/**
 * Every active tenancy with its own dates.
 *
 * Sorted by when serving becomes possible, because that is the order the work
 * actually arrives in. A list sorted by unit number is a list somebody reads
 * once.
 */
r.get("/increases/eligibility", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const withinDays = Number(c.req.query("within") ?? 120);

  const [policy] = await sql`SELECT * FROM rent_increase_policies
    WHERE is_active AND effective_from <= CURRENT_DATE
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY effective_from DESC LIMIT 1`;

  const rows = await sql`
    SELECT e.*, ct.full_name AS tenant_name, ct.email AS tenant_email, ct.locale
    FROM rent_increase_eligibility e
    LEFT JOIN leases l ON l.id = e.lease_id
    LEFT JOIN contacts ct ON ct.id = l.contact_id
    ORDER BY e.can_serve_from`;

  const horizon = addDays(today(), withinDays);

  const enriched = rows.map((x) => {
    // What the policy would produce for this tenancy. Worked out per lease
    // because a percentage of one rent is not a percentage of another.
    let proposed = null;
    if (policy && x.can_be_increased) {
      const base = Number(x.current_rent);
      const raw = policy.method === "percent"
        ? base * (1 + Number(policy.percent))
        : policy.method === "fixed"
        ? base + Number(policy.fixed_amount)
        : base;
      proposed = round(raw, policy.rounding);

      // A ceiling on any one step. Not the law — a tenant who would have
      // stayed and does not is a turnover, and that usually costs more than
      // the difference.
      if (policy.max_percent)
        proposed = Math.min(proposed, round(base * (1 + Number(policy.max_percent)),
          policy.rounding));
      if (policy.max_amount)
        proposed = Math.min(proposed, round(base + Number(policy.max_amount),
          policy.rounding));
    }

    const canServeIn = days(today(), x.can_serve_from);

    return { ...x,
      proposed_rent: proposed,
      increase_amount: proposed == null ? null : cents(proposed - Number(x.current_rent)),
      increase_percent: proposed == null ? null
        : Number((((proposed / Number(x.current_rent)) - 1) * 100).toFixed(2)),
      can_serve_in_days: canServeIn,
      // Why this one is or is not actionable today. Said in words rather than
      // as a flag, because "not eligible" without a date is not an answer.
      status: !x.can_be_increased
        ? "fixed_term"
        : x.has_live_notice ? "notice_out"
        : canServeIn <= 0 ? "serve_now"
        : canServeIn <= withinDays ? "coming_up"
        : "later",
      explain: !x.can_be_increased
        ? "Fixed term. The rent is what the agreement says until it ends — the new figure goes in the renewal instead."
        : x.has_live_notice ? "A notice is already out for this tenancy."
        : canServeIn <= 0
          ? `Can be served today, effective ${addDays(today(), INCREASE_NOTICE_DAYS)} at the earliest.`
          : `Eligible from ${x.eligible_from}. Serving can start ${x.can_serve_from}, which is ${canServeIn} days away.`,
    };
  });

  return c.json({
    policy: policy ?? null,
    eligibility: enriched,
    counts: {
      // The only number that means "there is work today".
      serve_now: enriched.filter((x) => x.status === "serve_now").length,
      coming_up: enriched.filter((x) => x.status === "coming_up").length,
      notice_out: enriched.filter((x) => x.status === "notice_out").length,
      fixed_term: enriched.filter((x) => x.status === "fixed_term").length,
    },
    note: "Each tenancy has its own anniversary. There is no date on which everybody can be increased, and picking one would serve some notices too early to be valid and the rest months late.",
  });
});

/* ---------- Preparing a notice ---------- */

/**
 * One notice, for one tenancy, on its own dates.
 *
 * Several can be prepared in a sitting — the endpoint takes a list — but each
 * is calculated and validated on its own, and the ones that cannot be served
 * come back with a reason rather than being quietly dropped.
 */
r.post("/increases/prepare", require_("settings.pricing.edit"), async (c) => {
  const sql = c.get("db");
  const { lease_ids, new_rents, effective_on, message } = await c.req.json();

  if (!Array.isArray(lease_ids) || !lease_ids.length)
    return c.json({ code: "NOTHING_SELECTED" }, 400);

  const [policy] = await sql`SELECT * FROM rent_increase_policies
    WHERE is_active AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`;

  const prepared = [];
  const skipped = [];

  for (const leaseId of lease_ids) {
    try {
      const one = await sql.begin(async (tx) => {
        const [e] = await tx`SELECT * FROM rent_increase_eligibility
          WHERE lease_id = ${leaseId}`;
        if (!e) throw new Error("LEASE_NOT_FOUND");

        if (!e.can_be_increased)
          throw new Error("FIXED_TERM");
        if (e.has_live_notice)
          throw new Error("NOTICE_ALREADY_OUT");

        const [lease] = await tx`
          SELECT l.*, ct.full_name, ct.email, ct.locale
          FROM leases l LEFT JOIN contacts ct ON ct.id = l.contact_id
          WHERE l.id = ${leaseId} FOR UPDATE`;

        const newRent = cents(new_rents?.[leaseId] ?? 0);
        if (!(newRent > Number(lease.rent)))
          throw new Error("NOT_AN_INCREASE");

        /* The effective date, per tenancy.
           
           It has to clear two separate things: this tenancy's own
           anniversary, and the notice period from whenever the notice is
           deemed received. Whichever is later wins, and a date that clears
           only one of them produces a void notice rather than a late one. */
        const earliestByNotice = addDays(today(), INCREASE_NOTICE_DAYS);
        const earliest = e.eligible_from > earliestByNotice
          ? e.eligible_from : earliestByNotice;
        const effective = effective_on && effective_on >= earliest
          ? effective_on : earliest;

        const [ri] = await tx`
          INSERT INTO rent_increases (id, policy_id, lease_id, unit_number, contact_id,
            current_rent, new_rent, increase_amount, increase_percent,
            anniversary_of, days_since, eligible_from, eligible,
            notice_days, effective_on, state)
          VALUES (${uid("ri_")}, ${policy?.id ?? null}, ${lease.id}, ${lease.unit_number},
                  ${lease.contact_id}, ${lease.rent}, ${newRent},
                  ${cents(newRent - Number(lease.rent))},
                  ${Number((((newRent / Number(lease.rent)) - 1) * 100).toFixed(4))},
                  ${e.anniversary_of}, ${e.days_since}, ${e.eligible_from}, TRUE,
                  ${INCREASE_NOTICE_DAYS}, ${effective}, 'draft')
          RETURNING *`;

        await tx`INSERT INTO rent_increase_events (id, increase_id, event, detail, actor_name)
          VALUES (${uid("rie_")}, ${ri.id}, 'prepared',
                  ${`${money(lease.rent)} to ${money(newRent)}, effective ${effective}`},
                  ${c.get("user").name})`;

        return { ...ri, tenant_name: lease.full_name, tenant_email: lease.email };
      });
      prepared.push(one);
    } catch (e) {
      // Skipped with a reason, not dropped. A batch that silently excludes
      // half the list is a batch somebody thinks went out.
      skipped.push({ lease_id: leaseId, code: e.message,
        detail: e.message === "FIXED_TERM"
          ? "Fixed term — the rent cannot move mid-term. It goes in the renewal."
          : e.message === "NOTICE_ALREADY_OUT"
          ? "A notice is already out for this tenancy."
          : e.message === "NOT_AN_INCREASE"
          ? "The figure given is not higher than the current rent."
          : null });
    }
  }

  await audit(c, { action: "increase.prepare", entityType: "rent_increase",
    entityId: null, after: { prepared: prepared.length, skipped: skipped.length } });

  return c.json({ prepared, skipped,
    note: "Drafted. Nothing has been served — each notice still has to be sent and its service recorded." }, 201);
});

/* ---------- Serving ---------- */

/**
 * Sending the notice, and recording how.
 *
 * The service method decides when it counts as received, and the notice
 * period runs from that date rather than from the day it was sent. Ordinary
 * mail is deemed received five days later, so a notice posted today and
 * effective in ninety days is five days short.
 */
r.post("/increases/:id/serve", require_("settings.pricing.edit"), async (c) => {
  const sql = c.get("db");
  const { method = "email", served_on, witness } = await c.req.json();

  try {
    const out = await sql.begin(async (tx) => {
      const [ri] = await tx`SELECT * FROM rent_increases WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!ri) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (ri.state !== "draft")
        throw Object.assign(new Error("ALREADY_SERVED"), { status: 409, state: ri.state });

      const [ct] = await tx`SELECT * FROM contacts WHERE id = ${ri.contact_id}`;
      const on = served_on || today();
      const deemed = addDays(on, DEEMED_SERVICE_DAYS[method] ?? 0);

      // The check the trigger also enforces, done here so the message is
      // useful rather than a database error.
      const earliest = addDays(deemed, ri.notice_days);
      if (ri.effective_on < earliest)
        throw Object.assign(new Error("NOTICE_TOO_SHORT"), { status: 409,
          detail: `Deemed received ${deemed}, so the earliest effective date is ${earliest}. Serving it for ${ri.effective_on} would void the increase rather than shorten it.`,
          earliest });

      const zh = ct?.locale === "zh";

      /* The notice itself. Structured rather than free text, because the
         required contents are the same every time and the one that gets
         missed is the one somebody typed.
         
         Alberta does not prescribe a form for this, unlike a notice to end a
         tenancy. Have the wording reviewed once and it can be reused. */
      const text = (zh ? [
        `租金調整通知`,
        ``,
        `單位：${ri.unit_number}`,
        `租客：${ct?.full_name ?? ""}`,
        `發出日期：${on}`,
        ``,
        `目前月租：${money(ri.current_rent)}`,
        `調整後月租：${money(ri.new_rent)}`,
        `調整金額：${money(ri.increase_amount)}（${ri.increase_percent}%）`,
        `生效日期：${ri.effective_on}`,
        ``,
        `本通知依 Alberta Residential Tenancies Act 發出。自上次調整（${ri.anniversary_of}）起已滿 ${ri.days_since} 天，並提前 ${ri.notice_days} 天通知。`,
        ``,
        `${ri.effective_on} 之前的租金維持不變。`,
        message ? `\n${message}` : ``,
        ``,
        `Baydo Pointe`,
      ] : [
        `NOTICE OF RENT INCREASE`,
        ``,
        `Suite: ${ri.unit_number}`,
        `Tenant: ${ct?.full_name ?? ""}`,
        `Date of this notice: ${on}`,
        ``,
        `Current rent: ${money(ri.current_rent)} per month`,
        `New rent: ${money(ri.new_rent)} per month`,
        `Increase: ${money(ri.increase_amount)} (${ri.increase_percent}%)`,
        `Effective: ${ri.effective_on}`,
        ``,
        `This notice is given under the Alberta Residential Tenancies Act. ` +
        `${ri.days_since} days have passed since the last increase on ${ri.anniversary_of}, ` +
        `and this notice gives ${ri.notice_days} days.`,
        ``,
        `The rent does not change before ${ri.effective_on}.`,
        message ? `\n${message}` : ``,
        ``,
        `Baydo Pointe`,
      ]).filter((x) => x !== undefined).join("\n");

      let outboxId = null;
      if (method === "email") {
        if (!ct?.email) throw Object.assign(new Error("NO_EMAIL"), { status: 400 });
        const [msg] = await tx`
          INSERT INTO outbox (id, channel, to_email, to_name, locale, kind, subject,
            body, ref_type, ref_id, required_by)
          VALUES (${uid("ob_")}, 'email', ${ct.email}, ${ct.full_name},
                  ${ct.locale ?? "en"}, 'rent_increase',
                  ${zh ? `租金調整通知 · ${ri.unit_number}`
                       : `Notice of rent increase · ${ri.unit_number}`},
                  ${text}, 'rent_increase', ${ri.id}, ${addDays(on, 1)})
          RETURNING id`;
        outboxId = msg.id;
      }

      await tx`UPDATE rent_increases
        SET state = 'served', served_on = ${on}, deemed_served_on = ${deemed},
            service_method = ${method}, served_by = ${c.get("user").name},
            witness = ${witness ?? null}, outbox_id = ${outboxId},
            notice_text = ${text}, notice_sha256 = ${await sha256(text)},
            approved_by = ${c.get("user").id}, approved_name = ${c.get("user").name},
            approved_at = now()
        WHERE id = ${ri.id}`;

      await tx`INSERT INTO rent_increase_events (id, increase_id, event, detail, actor_name)
        VALUES (${uid("rie_")}, ${ri.id}, 'served',
                ${`By ${method}, deemed received ${deemed}, effective ${ri.effective_on}`},
                ${c.get("user").name})`;

      // Methods with no delivery report need proof made by hand.
      const needsProof = ["personal", "posted_on_door", "post"].includes(method);

      return { deemed_served_on: deemed, effective_on: ri.effective_on,
        needs_proof: needsProof,
        proof_note: needsProof
          ? "This method leaves no delivery report. Photograph the notice or keep the receipt — an increase is challenged on service far more often than on the amount."
          : null };
    });

    await audit(c, { action: "increase.serve", entityType: "rent_increase",
      entityId: c.req.param("id"), after: out });
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail, earliest: e.earliest },
                  e.status ?? 500);
  }
});

r.post("/increases/:id/withdraw", require_("settings.pricing.edit"), async (c) => {
  const { reason } = await c.req.json();
  if (!reason?.trim()) return c.json({ code: "REASON_REQUIRED" }, 400);

  const sql = c.get("db");

  // One transaction. A withdrawal with no event recorded is a notice that
  // stopped applying with nothing to say who stopped it or why, which is the
  // whole point of withdrawing rather than deleting.
  const ri = await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE rent_increases SET state = 'withdrawn', withdrawn_reason = ${reason.trim()}
      WHERE id = ${c.req.param("id")} AND state IN ('draft','served')
      RETURNING *`;
    if (!row) return null;
    await tx`INSERT INTO rent_increase_events (id, increase_id, event, detail, actor_name)
      VALUES (${uid("rie_")}, ${row.id}, 'withdrawn', ${reason.trim()},
              ${c.get("user").name})`;
    return row;
  });
  if (!ri) return c.json({ code: "NOT_WITHDRAWABLE" }, 409);
  await audit(c, { action: "increase.withdraw", entityType: "rent_increase",
    entityId: ri.id, after: { reason } });

  return c.json({ ok: true,
    note: "Withdrawn. If you intend to increase this tenancy later, the notice period starts again from the new notice." });
});

r.get("/increases", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const state = c.req.query("state");
  const rows = state
    ? await sql`SELECT * FROM rent_increases WHERE state = ${state}
        ORDER BY effective_on LIMIT 300`
    : await sql`SELECT * FROM rent_increases ORDER BY created_at DESC LIMIT 300`;
  return c.json({ increases: rows });
});

export default r;
