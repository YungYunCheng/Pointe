/* ============================================================
   Cron

   What ran on setInterval in the container.

   Triggers fire in UTC and Alberta observes daylight saving, so
   every job works out the local date itself. A rent run that fires
   on the wrong side of midnight bills the wrong month, and it does
   it silently.
   ============================================================ */

import { INCREASE_INTERVAL_DAYS } from "./rules.js";

/** The date in Edmonton, whatever UTC thinks. */
export function albertaToday(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/* The five-minute cron's 07:00 UTC occurrence is sent to the daily job. The
   daily job also drains the outbox so notices created by the rent run do not
   wait for the next occurrence. */
export async function runDailyJobs(sql, env) {
  const today = albertaToday();
  const results = {};

  try {
    // Idempotent by design, so a retry after a failure adds nothing rather
    // than billing 330 tenants twice.
    results.rent = await dailyRentRun(sql, today);
    results.renewals = await scanRenewals(sql, today);
    results.schedules = await findStoppedSchedules(sql, today);
    results.increases = await applyDueIncreases(sql, today);
    results.unserved = await findUnservedIncreases(sql, today);
    results.refunds = await scanRefundDeadlines(sql, today);
    results.passwords = await passwordExpiryWarnings(sql, today);
    results.swept = await sweepExpired(sql);
    // The hourly job does not run at 07:00 because the dispatcher sends that
    // hour here. Drain anyway, or the 330 notices the rent run just queued
    // wait an extra hour.
    results.outbox = await drainOutbox(sql, env, 100);
    console.log("[cron:daily]", today, JSON.stringify(results));
  } catch (e) {
    console.error("[cron:daily]", e.message);
  }
  return results;
}

export async function runHourlyJobs(sql, env) {
  try {
    const out = await drainOutbox(sql, env, 50);
    if (out.attempted) console.log("[cron:hourly] outbox", JSON.stringify(out));
    return out;
  } catch (e) {
    console.error("[cron:hourly]", e.message);
  }
}

/** 14:00 UTC is early morning in Alberta year-round (07:00 MST / 08:00 MDT).
 * Move reminders live here rather than in the midnight accounting run. */
export async function runMorningMoveJobs(sql, env) {
  const today = albertaToday();
  try {
    const moves = await morningMoveReminders(sql, today);
    const outbox = await drainOutbox(sql, env, 50);
    console.log("[cron:morning-moves]", today, JSON.stringify(moves));
    return { moves, outbox };
  } catch (e) {
    console.error("[cron:morning-moves]", e.message);
    return { error: e.message };
  }
}

/** Every confirmed elevator booking for today reaches the Building Manager
 * once in the morning. The booking row is the idempotency key: a retry of the
 * daily job cannot send the same reminder twice. */
async function morningMoveReminders(sql, today) {
  const bookings = await sql`
    SELECT mb.*, ta.full_name AS tenant_name
    FROM move_elevator_bookings mb
    JOIN tenant_accounts ta ON ta.id = mb.account_id
    WHERE mb.move_date = ${today} AND mb.status = 'confirmed'
      AND mb.morning_reminder_at IS NULL
    ORDER BY mb.building_code, mb.time_from`;
  if (!bookings.length) return { reminded: 0, date: today };

  const managers = await sql`
    SELECT id, email, full_name FROM users
    WHERE role_code = 'building_manager' AND is_active ORDER BY full_name`;
  let reminded = 0;
  await sql.begin(async (tx) => {
    for (const booking of bookings) {
      const detail = `${booking.direction === "move_in" ? "Move-in" : "Move-out"} · ${booking.unit_number} · ${String(booking.time_from).slice(0,5)}–${String(booking.time_to).slice(0,5)}`;
      await tx`INSERT INTO notifications (id, audience, kind, code, params, link)
        VALUES (${uid("nt_")}, 'building_manager', 'move_booking',
          'MOVE_ELEVATOR_TODAY', ${JSON.stringify({ building: booking.building_code,
            unit: booking.unit_number, direction: booking.direction,
            from: String(booking.time_from).slice(0,5), to: String(booking.time_to).slice(0,5) })},
          '/schedule')`;
      for (const manager of managers) {
        await tx`INSERT INTO outbox (id, channel, to_email, to_name, kind, subject,
            body, ref_type, ref_id)
          VALUES (${uid("ob_")}, 'email', ${manager.email}, ${manager.full_name},
            'move_elevator_morning', ${`Elevator move today · Building ${booking.building_code}`},
            ${`Today's confirmed elevator booking: ${detail}. Open the staff Schedule for the full request.`},
            'move_elevator_booking', ${booking.id})`;
      }
      await tx`UPDATE move_elevator_bookings SET morning_reminder_at = now(),
        updated_at = now() WHERE id = ${booking.id} AND morning_reminder_at IS NULL`;
      reminded++;
    }
  });
  return { reminded, date: today, managers: managers.length };
}

/* ---------- The jobs themselves ---------- */

async function dailyRentRun(sql, today) {
  const period = today.slice(0, 7);
  const day = Number(today.slice(8, 10));

  /* charge_day <= today, not charge_day = today.
     
     A run that only looks at today's date misses the month entirely if cron
     did not fire — a deploy, an outage, a Cloudflare incident — and nothing
     ever goes back for it. Nobody notices until the arrears report is short
     by a month, by which point the tenants were never billed and the ledger
     says they owe nothing.
     
     Looking backwards means a missed day is picked up the next time this
     runs, and the NOT EXISTS check is what stops it billing twice. */
  const due = await sql`
    SELECT cs.*, l.unit_number, l.building_code
    FROM charge_schedules cs
    LEFT JOIN leases l ON l.id = cs.lease_id
    WHERE cs.is_active
      AND cs.charge_day <= ${day}
      AND cs.start_date <= ${today}
      AND (cs.end_date IS NULL OR cs.end_date >= ${today})
      AND NOT EXISTS (
        SELECT 1 FROM ar_charges c
        WHERE c.schedule_id = cs.id AND c.period = ${period})`;

  if (!due.length) return { raised: 0, period };

  /* One transaction for the whole run.
     
     A partial rent run is worse than none: half the building billed, and
     nobody able to tell which half without comparing two reports. All or
     nothing means a failure leaves the month clean and the job runs again
     tomorrow. */
  let raised = 0;
  const skipped = [];

  await sql.begin(async (tx) => {
    for (const s of due) {
      const dueDate = `${period}-${String(s.charge_day).padStart(2, "0")}`;

      /* The unique index on (schedule_id, period) is what actually makes this
         safe to repeat. ON CONFLICT DO NOTHING turns a second run into a
         no-op rather than an error, which matters because the alternative is
         a job that fails loudly every day after a partial success. */
      const [row] = await tx`
        INSERT INTO ar_charges (id, schedule_id, unit_number, building_code, period,
          kind, gl_code, amount, paid_amount, charge_date, due_date, state)
        VALUES (${uid("ch_")}, ${s.id}, ${s.unit_number}, ${s.building_code ?? null},
                ${period}, ${s.kind ?? "rent"}, ${s.gl_code ?? "4010"},
                ${s.amount}, 0, ${today}, ${dueDate}, 'open')
        ON CONFLICT (schedule_id, period) DO NOTHING
        RETURNING id`;

      if (row) raised++;
      else skipped.push(s.id);
    }
  });

  return { raised, period, already_raised: skipped.length };
}

const uid = (prefix) =>
  prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * Two kinds of lease need attention and only one of them has a date.
 *
 * A fixed term expiring announces itself. A periodic tenancy never does — it
 * has no end, so it appears on no list, and that is how a suite ends up three
 * years in at the rent it started on. Nobody decided that; there was simply
 * never a moment that raised the question.
 *
 * So periodic leases are scanned on their own clock: once 365 days have
 * passed and a review is legally possible again.
 */
async function scanRenewals(sql, today) {
  const horizon = new Date(new Date(today).getTime() + 90 * 864e5)
    .toISOString().slice(0, 10);

  const ending = await sql`
    SELECT id, unit_number, end_date FROM leases
    WHERE status = 'active' AND end_date IS NOT NULL
      AND end_date BETWEEN ${today} AND ${horizon}
      AND NOT EXISTS (SELECT 1 FROM renewal_offers o
        WHERE o.lease_id = leases.id
          AND o.state IN ('draft','sent','viewed','accepted','signing'))`;

  const reviewDue = await sql`
    SELECT id, unit_number, rent, last_increase_at FROM leases
    WHERE status = 'active' AND end_date IS NULL
      AND (last_increase_at IS NULL
           OR last_increase_at <= (${today}::date - INTERVAL '1 day' * ${INCREASE_INTERVAL_DAYS}))
      AND NOT EXISTS (SELECT 1 FROM renewal_offers o
        WHERE o.lease_id = leases.id
          AND o.state IN ('draft','sent','viewed','accepted','signing'))
      -- Told about once a month, not every morning. A notification that
      -- arrives daily for a thing with no deadline is a notification people
      -- learn to dismiss.
      AND NOT EXISTS (SELECT 1 FROM notifications n
        WHERE n.code = 'RENT_REVIEW_DUE'
          AND n.payload::jsonb->>'unit' = leases.unit_number
          AND n.created_at > now() - INTERVAL '30 days')`;

  for (const l of ending)
    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'property_manager', 'renewal', 'LEASE_ENDING',
              ${JSON.stringify({ unit: l.unit_number, end_date: l.end_date })},
              '/portfolio')`;

  for (const l of reviewDue)
    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'property_manager', 'renewal', 'RENT_REVIEW_DUE',
              ${JSON.stringify({ unit: l.unit_number, rent: l.rent,
                                 since: l.last_increase_at })},
              '/portfolio')`;

  return { ending: ending.length, rent_review_due: reviewDue.length };
}

/**
 * Schedules that have quietly stopped.
 *
 * A charge schedule whose end date has passed while the lease is still active
 * bills nothing and says nothing. Arrears stays clean because no charge was
 * raised, the tenant does not complain because no invoice arrived, and one
 * suite out of 330 does not move the monthly total enough to see.
 *
 * This is the check that catches it in a week rather than at year end.
 */
async function findStoppedSchedules(sql, today) {
  const stopped = await sql`
    SELECT cs.id, cs.unit_number, cs.kind, cs.amount, cs.end_date, l.term_type
    FROM charge_schedules cs
    JOIN leases l ON l.id = cs.lease_id
    WHERE cs.is_active AND l.status = 'active'
      AND cs.end_date IS NOT NULL AND cs.end_date < ${today}
      -- The lease says the tenancy continues; the schedule says it stopped.
      -- One of them is wrong and it is not the lease.
      AND (l.end_date IS NULL OR l.end_date >= ${today})`;

  for (const s of stopped)
    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'accounting', 'accounting', 'SCHEDULE_STOPPED',
              ${JSON.stringify({ unit: s.unit_number, kind: s.kind,
                                 amount: s.amount, ended: s.end_date })},
              '/accounting')
      ON CONFLICT DO NOTHING`;

  if (stopped.length)
    console.warn(`[schedules] ${stopped.length} stopped while the tenancy continues`);

  return { stopped: stopped.length };
}

async function scanRefundDeadlines(sql, today) {
  const rows = await sql`
    SELECT id, unit_number, refund_due_by FROM moveouts
    WHERE state = 'open' AND refund_due_by IS NOT NULL
      AND refund_due_by <= ${today}`;
  return { overdue: rows.length };
}

async function passwordExpiryWarnings(sql, today) {
  const soon = new Date(new Date(today).getTime() + 14 * 864e5).toISOString();
  const rows = await sql`
    SELECT id, email, full_name, password_expires_at FROM users
    WHERE is_active AND password_expires_at IS NOT NULL
      AND password_expires_at <= ${soon} AND password_expires_at > now()`;
  return { warned: rows.length };
}

/**
 * Rent increases that take effect today.
 *
 * The automation the whole flow is for: the rent changes on its date without
 * anybody remembering, and every downstream schedule changes with it.
 *
 * Two things it will not do.
 *
 * It only applies notices that were actually served. A confirmed one that
 * never went out is a decision somebody made and never told the tenant about,
 * and charging it would be charging a rent nobody was given notice of.
 *
 * It will not apply one before its effective date, even if that date has been
 * edited since. The date on the notice is the date the tenant was told, and
 * that is the only one that counts.
 */
async function applyDueIncreases(sql, today) {
  const due = await sql`
    SELECT * FROM rent_increases
    WHERE state IN ('served','acknowledged') AND effective_on <= ${today}`;

  if (!due.length) return { applied: 0 };

  const applied = [];
  for (const ri of due) {
    try {
      await sql.begin(async (tx) => {
        const [lease] = await tx`SELECT * FROM leases WHERE id = ${ri.lease_id}
          FOR UPDATE`;

        // The tenancy ended between serving and the effective date. Nothing to
        // increase, and quietly raising a rent on a suite somebody has left
        // would put a charge on an empty unit.
        if (!lease || lease.status !== "active") {
          await tx`UPDATE rent_increases SET state = 'withdrawn',
            withdrawn_reason = 'The tenancy ended before the effective date.'
            WHERE id = ${ri.id}`;
          return;
        }

        await tx`UPDATE leases
          SET rent = ${ri.new_rent}, last_increase_at = ${ri.effective_on}
          WHERE id = ${lease.id}`;

        /* The schedule too, or the lease says one figure and the tenant is
           billed another. That mismatch is invisible until somebody queries
           their statement, and by then several months have been billed
           wrongly. */
        await tx`UPDATE charge_schedules SET amount = ${ri.new_rent}
          WHERE lease_id = ${lease.id} AND kind = 'rent' AND is_active`;

        await tx`UPDATE rent_increases SET state = 'applied', applied_at = now()
          WHERE id = ${ri.id}`;
        await tx`INSERT INTO rent_increase_events (id, increase_id, event, detail)
          VALUES (${uid("ie_")}, ${ri.id}, 'applied',
                  ${`Rent and schedules moved to ${ri.new_rent} on ${ri.effective_on}.`})`;

        // Told, not left to be discovered on the next invoice.
        await tx`INSERT INTO notifications (id, audience, kind, code, params, link)
          VALUES (${uid("nt_")}, 'accounting', 'accounting', 'RENT_INCREASE_APPLIED',
                  ${JSON.stringify({ unit: ri.unit_number, from: ri.current_rent,
                                     to: ri.new_rent, on: ri.effective_on })},
                  '/accounting')`;
      });
      applied.push(ri.unit_number);
    } catch (e) {
      console.error(`[increase] ${ri.unit_number}:`, e.message);
    }
  }

  if (applied.length) console.log(`[increase] applied to ${applied.join(", ")}`);
  return { applied: applied.length, units: applied };
}

/**
 * Increases confirmed but never served.
 *
 * A decision somebody made and nobody told the tenant about. Left alone it
 * sits there until its effective date passes, and then it never applies —
 * because it was never served, and applying it would charge a rent nobody was
 * given notice of.
 */
async function findUnservedIncreases(sql, today) {
  const stale = await sql`
    SELECT * FROM rent_increases
    WHERE state = 'confirmed' AND confirmed_at < now() - INTERVAL '7 days'`;

  for (const ri of stale)
    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'property_manager', 'renewal', 'INCREASE_NOT_SERVED',
              ${JSON.stringify({ unit: ri.unit_number, confirmed: ri.confirmed_at,
                                 effective: ri.effective_on })},
              '/portfolio')
      ON CONFLICT DO NOTHING`;

  return { unserved: stale.length };
}

/**
 * Rent increases whose effective date has arrived.
 *
 * The lease and every schedule move together, for the same reason a renewal
 * does: a lease showing the new rent while the schedule still raises the old
 * one is a mismatch nobody notices until a tenant queries their statement.
 *
 * Two things are re-checked here rather than trusted from when the notice was
 * served. A notice withdrawn last week should not take effect today, and a
 * tenancy that ended in the meantime has no rent to increase. Neither is
 * common; both are silent when they happen.
 *
 * last_increase_at is set to the effective date on the notice, not to today.
 * The next 365 days run from when the rent changed under the agreement, and
 * a job that ran a day late would otherwise move every future anniversary
 * with it.
 */
/**
 * Expired credentials, removed.
 *
 * A session table that only ever grows is a table that gets slower every
 * month and, more to the point, keeps a record of every sign-in forever for
 * no reason anybody can defend. The audit log records who signed in and when
 * — the session row itself is only useful while it works.
 *
 * Kept for a week past expiry rather than deleted the moment it lapses,
 * because a support question about a session usually arrives a few days
 * after it stopped working.
 */
async function sweepExpired(sql) {
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();

  const staff = await sql`DELETE FROM sessions
    WHERE expires_at < ${cutoff} OR (revoked_at IS NOT NULL AND revoked_at < ${cutoff})
    RETURNING id`;
  const tenant = await sql`DELETE FROM tenant_sessions
    WHERE expires_at < ${cutoff} OR (revoked_at IS NOT NULL AND revoked_at < ${cutoff})
    RETURNING id`;

  // Reset tokens go sooner. They are valid for thirty minutes, so one a day
  // old is either used or abandoned, and an unused one sitting in a table is
  // a live credential for anybody who reaches the database.
  const resets = await sql`DELETE FROM password_reset_tokens
    WHERE expires_at < now() - INTERVAL '1 day' RETURNING id`;

  // Confirmation tokens likewise, though these are longer-lived by design.
  const confirms = await sql`DELETE FROM confirmations
    WHERE expires_at IS NOT NULL AND expires_at < now() - INTERVAL '30 days'
    RETURNING id`;

  return { sessions: staff.length + tenant.length, resets: resets.length,
           confirmations: confirms.length };
}

/**
 * Delivery. Queued messages go out here rather than from the request that
 * caused them, so a provider outage delays a message instead of losing it
 * with nobody knowing which ones went missing.
 */
/**
 * Messages an agent claimed and never reported on.
 *
 * An agent can die between pulling and sending — a crashed script, a machine
 * rebooted, a network that went away mid-batch. Without this they sit marked
 * as in flight forever and nobody sends them, which looks identical on screen
 * to having been sent.
 */
async function reclaimLeases(sql) {
  const back = await sql`
    UPDATE outbox SET state = 'queued', lease_id = NULL, leased_until = NULL,
      last_error = 'The agent that claimed this never reported back'
    WHERE state = 'sending' AND leased_until < now()
    RETURNING id`;
  if (back.length) console.warn(`[outbox] ${back.length} leases expired and returned`);
  return back.length;
}

async function drainOutbox(sql, env, limit) {
  // Anything abandoned comes back before deciding what to send.
  await reclaimLeases(sql);

  const rows = await sql`
    SELECT * FROM outbox
    WHERE state = 'queued' AND channel IN ('email', 'both')
    ORDER BY created_at LIMIT ${limit}`;
  if (!rows.length) return { attempted: 0, sent: 0 };

  let sent = 0;
  for (const row of rows) {
    try {
      if (!env.RESEND_API_KEY) {
        // No provider. Recorded as unattempted rather than failed, because a
        // message nobody tried to send is a different problem from one that
        // bounced.
        await sql`UPDATE outbox SET
          last_error = 'No delivery provider configured' WHERE id = ${row.id}`;
        continue;
      }

      if (!row.to_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.to_email)) {
        await sql`UPDATE outbox SET attempts = 5, state = 'failed',
          last_error = 'Missing or invalid email address' WHERE id = ${row.id}`;
        continue;
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`,
                   "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${env.FROM_NAME ?? "Baydo Pointe"} <${env.FROM_EMAIL ?? "noreply@themizar.ca"}>`,
          to: [row.to_email],
          subject: row.subject ?? "A message from Baydo Pointe",
          text: row.body,
          reply_to: env.REPLY_TO_EMAIL ?? "rentals@themizar.ca",
        }),
      });

      if (!res.ok) {
        // Resend returns the useful reason in its JSON body (for example an
        // unverified sending domain or a restricted API key). Keeping only
        // the HTTP status made every configuration problem look identical.
        const raw = await res.text().catch(() => "");
        let detail = raw;
        try {
          const parsed = JSON.parse(raw);
          detail = parsed.message ?? parsed.name ?? parsed.error ?? raw;
        } catch (_) {}
        detail = String(detail || res.statusText || "Provider rejected the message")
          .replace(/\s+/g, " ").slice(0, 350);
        throw new Error(`EMAIL_${res.status}: ${detail}`);
      }
      const { id } = await res.json();
      await sql`UPDATE outbox SET state='sent', sent_at=now(), provider_id=${id ?? null},
        attempts = attempts + 1 WHERE id = ${row.id}`;
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      await sql`UPDATE outbox SET attempts=${attempts}, last_error=${e.message},
        state=${attempts >= 5 ? "failed" : "queued"} WHERE id = ${row.id}`;
    }
  }

  const alerts = await raiseDeliveryAlerts(sql);
  return { attempted: rows.length, sent, ...alerts };
}

/**
 * One notification a day saying what went out.
 *
 * Not nine hundred. A message per message would mean seven interruptions a
 * day each, of which perhaps one a month needs anybody to do anything — and
 * a list at that ratio is a list people stop opening.
 *
 * One a day is different. It is a thing somebody glances at with their
 * coffee, and the value is not the total: it is that a morning with no
 * receipts, or forty notices of entry, looks wrong at a glance in a way no
 * individual message ever does.
 */
async function dailyDigest(sql) {
  const [already] = await sql`SELECT 1 FROM notifications
    WHERE code = 'DAILY_DIGEST' AND created_at > CURRENT_DATE`;
  if (already) return { skipped: true };

  const rows = await sql`
    SELECT kind,
           COUNT(*) FILTER (WHERE state = 'sent')::int   AS sent,
           COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE state = 'queued')::int AS waiting
    FROM outbox
    WHERE created_at > CURRENT_DATE - INTERVAL '1 day'
    GROUP BY kind ORDER BY 2 DESC`;

  if (!rows.length) return { sent: 0 };

  const total = rows.reduce((s, x) => s + x.sent, 0);
  const failed = rows.reduce((s, x) => s + x.failed, 0);

  await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
    VALUES (${uid("nt_")}, 'property_manager', 'system', 'DAILY_DIGEST',
            ${JSON.stringify({ total, failed,
              by_kind: rows.map((r) => ({ kind: r.kind, sent: r.sent,
                failed: r.failed, waiting: r.waiting })) })},
            '/messages')`;

  return { sent: total, failed };
}

/**
 * Telling somebody a message did not go.
 *
 * Three kinds of failure with three different consequences, so three
 * different responses. Treating them the same means either a stream of
 * notifications nobody reads, or a silence that hides the one that mattered.
 *
 * Who hears about it matters as much as whether. A dead email address is
 * fixable by whoever manages that tenancy; a mail server that has stopped
 * accepting anything is not, and telling the Property Manager about it just
 * moves the problem to somebody who cannot act on it.
 */
async function raiseDeliveryAlerts(sql) {
  /* 1. Past its deadline.
     
     The one that matters legally. A notice of entry still sitting in the
     queue has not given twenty-four hours whatever the screen says, and
     somebody may be standing at a door right now. A rent increase past its
     date is a notice that will not support the increase. */
  const overdue = await sql`
    SELECT id, kind, to_email, ref_type, ref_id, required_by, attempts, last_error
    FROM outbox
    WHERE state IN ('queued','failed')
      AND required_by IS NOT NULL AND required_by::timestamptz < now()
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.code = 'DELIVERY_OVERDUE'
          AND n.params::jsonb->>'outbox_id' = outbox.id
          -- Repeated every six hours while it is still true, rather than
          -- once. Something this consequential should keep asking.
          AND n.created_at > now() - INTERVAL '6 hours')`;

  for (const m of overdue) {
    // Legal notices go to the Property Manager, who can serve another one.
    // Everything else to whoever runs the building.
    const audience = ["entry_notice", "rent_increase", "renewal", "arrears"]
      .includes(m.kind) ? "property_manager" : "building_manager";

    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, ${audience}, 'system', 'DELIVERY_OVERDUE',
              ${JSON.stringify({ outbox_id: m.id, message_kind: m.kind,
                to: m.to_email, required_by: m.required_by,
                attempts: m.attempts, error: m.last_error,
                consequence: m.kind === "entry_notice"
                  ? "The 24 hours have not run. Do not attend without serving another notice."
                  : m.kind === "rent_increase"
                  ? "This notice will not support the increase. It has to be served again, and the period starts over."
                  : null })},
              '/admin?outbox=' || ${m.id})`;
  }

  /* 2. Permanently failed — a dead address.
     
     Retrying does not fix it. Somebody has to correct the address, and until
     they do every future message to that tenancy fails the same way. */
  const dead = await sql`
    SELECT o.id, o.kind, o.to_email, o.last_error, o.ref_type, o.ref_id,
           c.id AS contact_id, c.full_name
    FROM outbox o
    LEFT JOIN contacts c ON lower(c.email) = lower(o.to_email)
    WHERE o.state = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.code = 'ADDRESS_UNDELIVERABLE'
          AND n.params::jsonb->>'email' = o.to_email
          -- Once per address, not once per message. A tenancy with four
          -- pending messages to a dead mailbox is one problem.
          AND n.created_at > now() - INTERVAL '7 days')`;

  const seen = new Set();
  for (const m of dead) {
    if (seen.has(m.to_email)) continue;
    seen.add(m.to_email);

    await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${uid("nt_")}, 'property_manager', 'system', 'ADDRESS_UNDELIVERABLE',
              ${JSON.stringify({ email: m.to_email, name: m.full_name,
                contact_id: m.contact_id, message_kind: m.kind,
                error: m.last_error,
                note: "Nothing will reach this address until it is corrected. Every message to this tenancy is failing the same way." })},
              ${m.contact_id ? `/leads?contact=${m.contact_id}` : "/admin"})`;
  }

  /* 3. Nothing is going out at all.
     
     A backlog with no successes is not several failed messages — it is a
     provider or an agent that has stopped, and it needs somebody who can
     restart something rather than somebody who manages tenancies. */
  const [health] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'sent'
        AND sent_at > now() - INTERVAL '2 hours')::int AS recent,
      MAX(sent_at) AS last_sent
    FROM outbox`;

  if (health.queued >= 5 && health.recent === 0) {
    const [existing] = await sql`SELECT 1 FROM notifications
      WHERE code = 'DELIVERY_STOPPED' AND created_at > now() - INTERVAL '2 hours'`;
    if (!existing)
      await sql`INSERT INTO notifications (id, audience, kind, code, params, link)
        VALUES (${uid("nt_")}, 'admin', 'system', 'DELIVERY_STOPPED',
                ${JSON.stringify({ queued: health.queued,
                  last_sent: health.last_sent,
                  note: "Nothing has gone out in two hours and messages are stacking up. Check the delivery agent and the mail server." })},
                '/admin')`;
  }

  if (overdue.length)
    console.warn(`[outbox] ${overdue.length} past their deadline`);
  if (seen.size)
    console.warn(`[outbox] ${seen.size} undeliverable address(es)`);

  return { overdue: overdue.length, undeliverable: seen.size,
           stopped: health.queued >= 5 && health.recent === 0 };
}
