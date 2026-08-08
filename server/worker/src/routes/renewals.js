import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";
import { INCREASE_INTERVAL_DAYS, END_NOTICE_DAYS, RENEWAL_LEAD_DAYS } from "../lib/rules.js";
import { randToken, sha256 } from "../lib/crypto.js";

/* ============================================================
   Renewals

   A lease ending is the cheapest tenant there is. Finding a new
   one costs a vacancy, a turnover and the leasing work; keeping
   this one costs a conversation eight weeks early.

   The order matters. Terms first, then the question. "Will you be
   staying?" with no rent attached is a question nobody can
   answer, and asking it that way spends the one round of
   correspondence that might have settled it.
   ============================================================ */

const r = new Hono();

/* Legal figures. Named constants because they are the law rather than a
   preference, and every one of them should be confirmed with your manager
   before the first notice goes out. */
const OFFER_TTL_DAYS = 21;

const today = () => new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const addDays = (d, n) =>
  new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(Number(n ?? 0));

/* ---------- What needs deciding ---------- */

r.get("/renewals", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const horizon = addDays(today(), RENEWAL_LEAD_DAYS);

  /* Two things belong on this screen and only one of them has an end date.
     
     A fixed term expiring is obvious. A periodic tenancy has no expiry, so it
     never appears on any list again — and that is exactly how a suite ends up
     three years into a tenancy at the rent it started on. Nobody decided
     that; there was simply never a moment that raised the question.
     
     So a periodic lease surfaces here on its own clock: once the 365 days
     have passed and a review is possible again. */
  const rows = await sql`
    SELECT l.id, l.unit_number, l.start_date, l.end_date, l.term_type, l.rent,
           l.last_increase_at, l.contact_id,
           ct.full_name AS tenant_name, ct.email AS tenant_email, ct.locale,
           ta.id AS account_id,
           ro.id AS offer_id, ro.state AS offer_state, ro.outcome, ro.offered_rent,
           ro.sent_at, ro.responded_at, ro.response_note
    FROM leases l
    LEFT JOIN contacts ct ON ct.id = l.contact_id
    LEFT JOIN tenant_accounts ta ON ta.lease_id = l.id AND ta.is_active
    LEFT JOIN renewal_offers ro ON ro.lease_id = l.id
      AND ro.state IN ('draft','sent','viewed','accepted','signing')
    WHERE l.status = 'active'
      AND (
        -- Fixed terms coming to an end.
        (l.end_date IS NOT NULL AND l.end_date <= ${horizon})
        OR
        -- Periodic tenancies where a rent review is due and possible.
        (l.end_date IS NULL
         AND (l.last_increase_at IS NULL
              OR l.last_increase_at <= (CURRENT_DATE - INTERVAL '1 day' * \))
         AND NOT EXISTS (
           SELECT 1 FROM renewal_offers x
           WHERE x.lease_id = l.id
             AND x.state IN ('draft','sent','viewed','accepted','signing')))
      )
    ORDER BY l.end_date NULLS LAST, l.last_increase_at NULLS FIRST`;

  const enriched = rows.map((l) => {
    const periodic = l.end_date == null;
    const left = periodic ? null : days(today(), l.end_date);
    const notice = END_NOTICE_DAYS[l.term_type === "periodic" ? "periodic" : "fixed"];
    const since = l.last_increase_at ? days(l.last_increase_at, today()) : null;

    /* The 365-day rule, checked before anybody is offered anything.
       An increase inside that window does not just get refused later — it can
       invalidate the notice, and then the whole renewal has to start again
       with less time than before. */
    const canRaise = since == null || since >= INCREASE_INTERVAL_DAYS;

    return { ...l,
      periodic,
      days_left: left,
      notice_days: notice,
      // A periodic tenancy has no date to work back from. The notice period
      // still applies, but it runs from whenever notice is actually given.
      notice_due_by: periodic ? null : addDays(l.end_date, -notice),
      notice_overdue: periodic ? false : left < notice,
      // Why this one is on the list. "Ending soon" and "has been at the same
      // rent for over a year" are different jobs, and lumping them together
      // means the second never gets done.
      reason: periodic ? "rent_review" : "term_ending",
      months_at_this_rent: l.last_increase_at
        ? Math.floor(days(l.last_increase_at, today()) / 30.44) : null,
      days_since_increase: since,
      increase_permitted: canRaise,
      increase_blocked_reason: canRaise ? null
        : `${since} days since the last increase. ${INCREASE_INTERVAL_DAYS} are required, so the earliest is ${addDays(l.last_increase_at, INCREASE_INTERVAL_DAYS)}.`,
      urgency: periodic ? "planned"
        : left <= 30 ? "urgent" : left <= 60 ? "soon" : "planned" };
  });

  return c.json({
    renewals: enriched,
    // What to act on today, rather than a count of everything.
    needs_decision: enriched.filter((x) => !x.offer_id).length,
    term_ending: enriched.filter((x) => x.reason === "term_ending").length,
    // The ones that would otherwise never come up again.
    rent_review_due: enriched.filter((x) => x.reason === "rent_review").length,
    awaiting_tenant: enriched.filter((x) => ["sent", "viewed"].includes(x.offer_state)).length,
    notice_overdue: enriched.filter((x) => x.notice_overdue && !x.sent_at).length,
    rules: { increase_interval_days: INCREASE_INTERVAL_DAYS, notice_days: NOTICE_DAYS,
      note: "These are legal figures. Confirm them before the first notice goes out." },
  });
});

/* ---------- Making the offer ---------- */

/**
 * The Property Manager sets the terms and the offer goes out.
 *
 * Month to month and a new fixed term are different pieces of paperwork.
 * A continuation usually runs on under the existing agreement and nothing is
 * signed; a new term is a new agreement and both parties sign it. Which
 * applies depends on what the original lease says, so it is a choice here
 * rather than an assumption.
 */
r.post("/renewals/:leaseId/offer", require_("renewals.decide"), async (c) => {
  const sql = c.get("db");
  const { outcome, offered_rent, term_months, message, internal_note,
          requires_signature, agreement_id } = await c.req.json();

  if (!["fixed_term", "month_to_month", "not_renewing"].includes(outcome))
    return c.json({ code: "INVALID_OUTCOME" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [lease] = await tx`
        SELECT l.*, ct.full_name, ct.email, ct.locale
        FROM leases l LEFT JOIN contacts ct ON ct.id = l.contact_id
        WHERE l.id = ${c.req.param("leaseId")} AND l.status = 'active' FOR UPDATE`;
      if (!lease) throw Object.assign(new Error("LEASE_NOT_FOUND"), { status: 404 });

      const rent = offered_rent == null ? Number(lease.rent) : Number(offered_rent);
      const since = lease.last_increase_at ? days(lease.last_increase_at, today()) : null;
      const canRaise = since == null || since >= INCREASE_INTERVAL_DAYS;

      // Refused here, not warned about. An increase served inside the window
      // can invalidate the notice, and the renewal then restarts with less
      // time than it had.
      if (rent > Number(lease.rent) && !canRaise)
        throw Object.assign(new Error("INCREASE_TOO_SOON"), { status: 409,
          detail: `${since} days since the last increase. ${INCREASE_INTERVAL_DAYS} are required.`,
          earliest: addDays(lease.last_increase_at, INCREASE_INTERVAL_DAYS) });

      const notice = END_NOTICE_DAYS[lease.term_type === "periodic" ? "periodic" : "fixed"];
      const starts = addDays(lease.end_date, 1);
      const ends = outcome === "fixed_term" && term_months
        ? addDays(starts, Math.round(term_months * 30.44) - 1) : null;

      // A month-to-month continuation is usually not signed; a new term
      // always is. Overridable, because what the original agreement says
      // decides it and this system has not read it.
      const needsSig = requires_signature ?? (outcome === "fixed_term");

      const token = randToken();
      const [account] = await tx`SELECT id FROM tenant_accounts
        WHERE lease_id = ${lease.id} AND is_active`;

      const [offer] = await tx`
        INSERT INTO renewal_offers (id, lease_id, unit_number, contact_id, account_id,
          outcome, current_rent, offered_rent, term_months, starts_on, ends_on,
          requires_signature, agreement_id, last_increase_on, days_since_increase,
          increase_permitted, notice_days, notice_due_by, message, internal_note,
          access_token, expires_at, state, decided_by, decided_name)
        VALUES (${uid("ro_")}, ${lease.id}, ${lease.unit_number}, ${lease.contact_id},
                ${account?.id ?? null}, ${outcome}, ${lease.rent},
                ${outcome === "not_renewing" ? null : rent},
                ${term_months ?? null}, ${starts}, ${ends},
                ${needsSig}, ${agreement_id ?? null},
                ${lease.last_increase_at ?? null}, ${since}, ${canRaise},
                ${notice}, ${addDays(lease.end_date, -notice)},
                ${message ?? null}, ${internal_note ?? null},
                ${await sha256(token)},
                ${new Date(Date.now() + OFFER_TTL_DAYS * 864e5).toISOString()},
                'draft', ${c.get("user").id}, ${c.get("user").name})
        RETURNING *`;

      await tx`INSERT INTO renewal_events (id, offer_id, event, detail, actor_name)
        VALUES (${uid("re_")}, ${offer.id}, 'drafted',
                ${`${outcome}${rent !== Number(lease.rent) ? ` at ${money(rent)}` : " at the same rent"}`},
                ${c.get("user").name})`;

      return { offer, token, lease };
    });

    await audit(c, { action: "renewal.draft", entityType: "lease",
      entityId: c.req.param("leaseId"),
      before: { rent: out.lease.rent },
      after: { outcome, offered_rent, by: c.get("user").name } });

    return c.json({ offer: { ...out.offer, access_token: undefined },
      // Returned once, here. It is hashed at rest, so this is the only moment
      // the raw token exists outside the email.
      link: `${c.env.PUBLIC_TENANT_URL}/renewal?token=${out.token}`,
      note: "Drafted. Nothing has gone to the tenant yet." }, 201);
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail, earliest: e.earliest },
                  e.status ?? 500);
  }
});

/** Sending it. Separate from drafting, so somebody can look at the wording
 *  before it reaches a tenant. */
r.post("/renewals/offers/:id/send", require_("renewals.decide"), async (c) => {
  const sql = c.get("db");

  try {
    const out = await sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM renewal_offers WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!o) throw Object.assign(new Error("OFFER_NOT_FOUND"), { status: 404 });
      if (o.state !== "draft")
        throw Object.assign(new Error("ALREADY_SENT"), { status: 409, state: o.state });

      const [ct] = await tx`SELECT * FROM contacts WHERE id = ${o.contact_id}`;
      if (!ct?.email) throw Object.assign(new Error("NO_EMAIL"), { status: 400 });

      // A fresh token. The one handed back at draft time may have been sitting
      // in somebody's clipboard or a browser history for a week.
      const token = randToken();
      await tx`UPDATE renewal_offers SET access_token = ${await sha256(token)},
        state = 'sent', sent_at = now() WHERE id = ${o.id}`;

      const zh = ct.locale === "zh";
      const link = `${c.env.PUBLIC_TENANT_URL}/renewal?token=${token}`;
      const change = Number(o.offered_rent ?? 0) - Number(o.current_rent);

      const body = o.outcome === "not_renewing" ? (zh ? [
        `${ct.full_name} 你好，`, "",
        `${o.unit_number} 的租約將於 ${addDays(o.starts_on, -1)} 到期，這次不會續約。`,
        "", "我們會另外聯絡你安排遷出檢查與押金退還。",
        o.message ? `\n${o.message}` : "",
      ] : [
        `Hello ${ct.full_name},`, "",
        `Your lease for ${o.unit_number} ends on ${addDays(o.starts_on, -1)} and will not be renewed.`,
        "", "We will be in touch about the move-out inspection and the return of your deposit.",
        o.message ? `\n${o.message}` : "",
      ]) : (zh ? [
        `${ct.full_name} 你好，`, "",
        `${o.unit_number} 的租約於 ${addDays(o.starts_on, -1)} 到期，我們希望你續住。`,
        "",
        o.outcome === "month_to_month"
          ? `之後改為按月計租，月租 ${money(o.offered_rent)}。`
          : `續約 ${o.term_months} 個月，至 ${o.ends_on}，月租 ${money(o.offered_rent)}。`,
        change !== 0
          ? (change > 0 ? `（目前 ${money(o.current_rent)}，調整 ${money(change)}）`
                        : `（目前 ${money(o.current_rent)}，調降 ${money(Math.abs(change))}）`)
          : "（月租不變。）",
        o.message ? `\n${o.message}` : "",
        "", "請點以下連結告訴我們你的決定：", "", link, "",
        `連結於 ${String(o.expires_at).slice(0, 10)} 前有效。有問題直接回這封信就可以。`,
      ] : [
        `Hello ${ct.full_name},`, "",
        `Your lease for ${o.unit_number} ends on ${addDays(o.starts_on, -1)}, and we would like you to stay.`,
        "",
        o.outcome === "month_to_month"
          ? `From then it would continue month to month at ${money(o.offered_rent)}.`
          : `We are offering ${o.term_months} months to ${o.ends_on} at ${money(o.offered_rent)} a month.`,
        change !== 0
          ? (change > 0 ? `That is ${money(change)} more than the ${money(o.current_rent)} you pay now.`
                        : `That is ${money(Math.abs(change))} less than you pay now.`)
          : "The rent stays the same.",
        o.message ? `\n${o.message}` : "",
        "", "Let us know either way:", "", link, "",
        `The link is good until ${String(o.expires_at).slice(0, 10)}. Reply to this message if you would rather talk it through.`,
      ]);

      await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
        subject, body, ref_type, ref_id, required_by)
        VALUES (${uid("ob_")}, 'email', ${ct.email}, ${ct.full_name},
                ${ct.locale ?? "en"}, 'renewal',
                ${zh ? `${o.unit_number} 續約` : `Your lease at ${o.unit_number}`},
                ${body.filter((x) => x !== "").join("\n")},
                'renewal_offer', ${o.id}, ${o.notice_due_by})`;

      await tx`INSERT INTO renewal_events (id, offer_id, event, detail, actor_name)
        VALUES (${uid("re_")}, ${o.id}, 'sent', ${`To ${ct.email}`},
                ${c.get("user").name})`;

      return { to: ct.email };
    });

    await audit(c, { action: "renewal.send", entityType: "renewal_offer",
      entityId: c.req.param("id"), after: out });
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ code: e.message, state: e.state }, e.status ?? 500);
  }
});


/**
 * Putting a renewal into effect.
 *
 * One function, used by both paths — accepted-with-nothing-to-sign and
 * signed. Two copies of this would drift, and the half that drifted would be
 * the one nobody tested.
 *
 * The part that matters is the charge schedule. Its end date is a separate
 * column from the lease's, and moving one without the other is a silent
 * failure: the tenancy carries on, the tenant stays, everything on screen
 * looks right, and the rent simply stops being billed.
 *
 * Nothing surfaces it. Arrears stays clean because no charge was raised. The
 * tenant does not complain because no invoice arrived. One suite missing out
 * of 330 does not move the monthly total enough to notice. It gets found at
 * year end, or when somebody moves out and the numbers do not add up.
 */
async function applyRenewal(tx, o) {
  const periodic = o.outcome === "month_to_month";
  const raising = Number(o.offered_rent) > Number(o.current_rent);

  /* starts_on, not today.
     
     Every date that decides something legal is the one written on the
     agreement. A renewal commencing 1 September and signed on 20 August has
     its anniversary on 1 September, and taking the signing date would move
     every future increase eleven days later — every year, on every suite
     where the paperwork ran early, which is most of them. */

  await tx`UPDATE leases
    SET term_type = ${periodic ? "periodic" : "fixed"},
        end_date = ${periodic ? null : o.ends_on},
        rent = ${o.offered_rent},
        last_increase_at = ${raising ? o.starts_on : tx`last_increase_at`},   -- the agreement's date
        renewal_offer_id = ${o.id}
    WHERE id = ${o.lease_id}`;

  /* The schedule follows the lease, both the amount and the end.
     
     For a month-to-month renewal the end has to become NULL, or the rent run
     stops finding this schedule the day after the old fixed term would have
     expired. */
  await tx`UPDATE charge_schedules
    SET amount = ${o.offered_rent},
        end_date = ${periodic ? null : o.ends_on}
    WHERE lease_id = ${o.lease_id} AND kind = 'rent' AND is_active`;

  /* Parking, storage and pet rent run on their own schedules with their own
     end dates. They are easy to forget precisely because they are small — and
     a parking charge that quietly stops is $95 a month nobody misses until
     the year-end figures are short. */
  await tx`UPDATE charge_schedules
    SET end_date = ${periodic ? null : o.ends_on}
    WHERE lease_id = ${o.lease_id} AND kind <> 'rent' AND is_active`;

  await tx`INSERT INTO renewal_events (id, offer_id, event, detail)
    VALUES (${uid("re_")}, ${o.id}, 'applied',
            ${periodic
              ? `Now month to month at ${money(o.offered_rent)}. No end date; the rent and every other schedule run on until somebody gives notice.`
              : `Fixed to ${o.ends_on} at ${money(o.offered_rent)}.`})`;

  return { periodic, rent: o.offered_rent, ends: periodic ? null : o.ends_on };
}

/* ---------- What the tenant sees ---------- */

/** No sign-in. The token identifies one offer and is useless for anything
 *  else — putting an account in front of "do you want to stay" is how a
 *  response rate goes to nothing. */
r.get("/public/renewal/:token", async (c) => {
  const sql = c.get("db");
  const hash = await sha256(c.req.param("token"));

  const [o] = await sql`
    SELECT ro.*, ct.full_name, ct.locale, l.start_date AS current_start
    FROM renewal_offers ro
    LEFT JOIN contacts ct ON ct.id = ro.contact_id
    LEFT JOIN leases l ON l.id = ro.lease_id
    WHERE ro.access_token = ${hash}`;

  if (!o) return c.json({ code: "NOT_FOUND" }, 404);
  if (["withdrawn", "expired"].includes(o.state))
    return c.json({ code: o.state.toUpperCase() }, 410);
  if (o.expires_at && new Date(o.expires_at) < new Date())
    return c.json({ code: "EXPIRED", expired_at: o.expires_at }, 410);

  if (!o.viewed_at) {
    // Marking it opened and recording that it was opened are one act. Split,
    // a failure between them leaves an offer that looks unread in the queue
    // while the history says somebody read it.
    await sql.begin(async (tx) => {
      await tx`UPDATE renewal_offers SET viewed_at = now(),
        state = CASE WHEN state = 'sent' THEN 'viewed' ELSE state END
        WHERE id = ${o.id}`;
      await tx`INSERT INTO renewal_events (id, offer_id, event, ip)
        VALUES (${uid("re_")}, ${o.id}, 'opened',
                ${c.req.header("cf-connecting-ip") ?? null})`;
    });
  }

  return c.json({
    unit_number: o.unit_number,
    tenant_name: o.full_name,
    locale: o.locale,
    outcome: o.outcome,
    current_rent: o.current_rent,
    offered_rent: o.offered_rent,
    change: o.offered_rent == null ? null
      : Number(o.offered_rent) - Number(o.current_rent),
    term_months: o.term_months,
    starts_on: o.starts_on,
    ends_on: o.ends_on,
    current_ends: addDays(o.starts_on, -1),
    message: o.message,
    requires_signature: o.requires_signature,
    state: o.state,
    expires_at: o.expires_at,
    responded_at: o.responded_at,
  });
});

/**
 * The tenant answers.
 *
 * Declining is a normal outcome and the page says so. What somebody writes
 * when they decline is the most useful thing in this whole flow: it is the
 * only place the reason a tenancy ended is recorded by the person who ended
 * it, and it is usually fixable.
 */
r.post("/public/renewal/:token", async (c) => {
  const sql = c.get("db");
  const { response, note } = await c.req.json().catch(() => ({}));
  const ip = c.req.header("cf-connecting-ip") ?? null;

  if (!["accept", "decline", "discuss"].includes(response))
    return c.json({ code: "INVALID_RESPONSE" }, 400);

  const hash = await sha256(c.req.param("token"));

  try {
    const out = await sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM renewal_offers
        WHERE access_token = ${hash} FOR UPDATE`;
      if (!o) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (o.responded_at)
        throw Object.assign(new Error("ALREADY_ANSWERED"), { status: 409 });
      if (o.expires_at && new Date(o.expires_at) < new Date())
        throw Object.assign(new Error("EXPIRED"), { status: 410 });

      const state = response === "accept"
        ? (o.requires_signature ? "signing" : "completed")
        : response === "decline" ? "declined" : "viewed";

      await tx`UPDATE renewal_offers
        SET state = ${state}, response_note = ${note ?? null}, responded_at = now(),
            response_ip = ${ip},
            completed_at = ${state === "completed" ? sql`now()` : null}
        WHERE id = ${o.id}`;

      await tx`INSERT INTO renewal_events (id, offer_id, event, detail, ip)
        VALUES (${uid("re_")}, ${o.id}, ${response}, ${note ?? null}, ${ip})`;

      /* Accepted with nothing to sign — a month-to-month continuation under
         the existing agreement. The lease is extended here rather than
         waiting for somebody to remember. */
      if (state === "completed") await applyRenewal(tx, o);

      // Somebody hears about it either way, and quickly. A decline is a
      // vacancy to plan for; an acceptance needing signature is paperwork to
      // get out while there is still time.
      await tx`INSERT INTO notifications (id, role_code, kind, code, payload, link)
        VALUES (${uid("nt_")}, 'property_manager', 'renewal',
                ${response === "accept" ? "RENEWAL_ACCEPTED"
                  : response === "decline" ? "RENEWAL_DECLINED" : "RENEWAL_QUESTION"},
                ${JSON.stringify({ unit: o.unit_number, note: note ?? null })},
                ${`/portfolio?renewal=${o.id}`})`;

      return { state, requires_signature: o.requires_signature, offer: o };
    });

    return c.json({
      ok: true,
      state: out.state,
      next: out.state === "signing"
        ? "We will send the agreement to sign shortly."
        : out.state === "completed"
        ? "That is settled. Nothing else to do."
        : out.state === "declined"
        ? "Thank you for letting us know. We will be in touch about moving out."
        : "Somebody will be in touch to talk it through.",
    });
  } catch (e) {
    return c.json({ code: e.message }, e.status ?? 500);
  }
});

/* ---------- Turning an acceptance into a signature ---------- */

/**
 * The tenant said yes to a new term, so the agreement goes out to be signed.
 *
 * Built on the existing signing flow rather than beside it. A renewal signed
 * through a second, simpler path would be a second, simpler path — and the
 * certificate, the hash chain and the consent record are the parts that make
 * a signature worth anything.
 */
r.post("/renewals/offers/:id/prepare-signature", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const { version_id, landlord_name, landlord_email, fields } = await c.req.json();

  try {
    const out = await sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM renewal_offers WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!o) throw Object.assign(new Error("OFFER_NOT_FOUND"), { status: 404 });
      if (o.state !== "signing")
        throw Object.assign(new Error("NOT_ACCEPTED"), { status: 409, state: o.state,
          detail: "The tenant has not accepted this offer yet." });
      if (o.signature_request_id)
        throw Object.assign(new Error("ALREADY_PREPARED"), { status: 409 });

      const [v] = await tx`SELECT * FROM agreement_versions WHERE id = ${version_id}`;
      if (!v) throw Object.assign(new Error("VERSION_NOT_FOUND"), { status: 404 });
      // Only an approved version. Everything downstream assumes the wording
      // was reviewed by somebody qualified to review it.
      if (v.state !== "approved")
        throw Object.assign(new Error("VERSION_NOT_APPROVED"), { status: 409 });

      const [ct] = await tx`SELECT * FROM contacts WHERE id = ${o.contact_id}`;
      const reference = "SIG-" + crypto.randomUUID().slice(0, 8).toUpperCase();

      const [req] = await tx`
        INSERT INTO signature_requests (id, reference, version_id, agreement_id,
          unit_number, lease_id, source_sha256, source_filename, source_key,
          particulars, locale, message, expires_at, created_by, created_name, state)
        VALUES (${uid("sr_")}, ${reference}, ${v.id}, ${v.agreement_id},
                ${o.unit_number}, ${o.lease_id}, ${v.sha256}, ${v.filename},
                ${v.stored_path},
                ${JSON.stringify({ rent: o.offered_rent, start_date: o.starts_on,
                                   end_date: o.ends_on, term_months: o.term_months })},
                ${o.locale ?? ct?.locale ?? "en"},
                ${`Renewal of your tenancy at ${o.unit_number}.`},
                ${new Date(Date.now() + 14 * 864e5).toISOString()},
                ${c.get("user").id}, ${c.get("user").name}, 'draft')
        RETURNING *`;

      // Tenant first, landlord after. A countersignature on a document the
      // tenant has not signed means nothing.
      const tenantToken = randToken();
      await tx`INSERT INTO signature_parties (id, request_id, role, full_name, email,
        sign_order, access_token)
        VALUES (${uid("sp_")}, ${req.id}, 'tenant', ${ct?.full_name},
                ${ct?.email}, 1, ${tenantToken})`;
      if (landlord_name)
        await tx`INSERT INTO signature_parties (id, request_id, role, full_name, email,
          sign_order, access_token)
          VALUES (${uid("sp_")}, ${req.id}, 'landlord', ${landlord_name},
                  ${landlord_email ?? null}, 2, ${randToken()})`;

      await tx`UPDATE renewal_offers SET signature_request_id = ${req.id}
        WHERE id = ${o.id}`;
      await tx`INSERT INTO renewal_events (id, offer_id, event, detail, actor_name)
        VALUES (${uid("re_")}, ${o.id}, 'signature_prepared', ${reference},
                ${c.get("user").name})`;

      return { request: req, reference };
    });

    await audit(c, { action: "renewal.prepare_signature",
      entityType: "renewal_offer", entityId: c.req.param("id"),
      after: { reference: out.reference } });

    return c.json({ ok: true, signature_request: out.request,
      note: "Prepared. Send it from Agreements when the placement looks right." }, 201);
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail, state: e.state },
                  e.status ?? 500);
  }
});

/** Called when the signature completes. Extends the lease and records where
 *  it came from, so a tenancy has its own history rather than a series of
 *  unconnected leases. */
r.post("/renewals/offers/:id/complete", require_("lease.sign"), async (c) => {
  const sql = c.get("db");

  try {
    const out = await sql.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM renewal_offers WHERE id = ${c.req.param("id")}
        FOR UPDATE`;
      if (!o) throw Object.assign(new Error("OFFER_NOT_FOUND"), { status: 404 });
      if (o.state === "completed")
        throw Object.assign(new Error("ALREADY_COMPLETED"), { status: 409 });

      await applyRenewal(tx, o);

      await tx`UPDATE renewal_offers SET state = 'completed', completed_at = now()
        WHERE id = ${o.id}`;
      await tx`INSERT INTO renewal_events (id, offer_id, event, actor_name)
        VALUES (${uid("re_")}, ${o.id}, 'completed', ${c.get("user").name})`;

      return { unit: o.unit_number, rent: o.offered_rent, ends: o.ends_on };
    });

    await audit(c, { action: "renewal.complete", entityType: "renewal_offer",
      entityId: c.req.param("id"), after: out });
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ code: e.message }, e.status ?? 500);
  }
});

r.get("/renewals/offers/:id", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const [o] = await sql`SELECT * FROM renewal_offers WHERE id = ${c.req.param("id")}`;
  if (!o) return c.json({ code: "NOT_FOUND" }, 404);
  return c.json({
    offer: { ...o, access_token: undefined },
    events: await sql`SELECT * FROM renewal_events WHERE offer_id = ${o.id} ORDER BY at`,
  });
});

export default r;
