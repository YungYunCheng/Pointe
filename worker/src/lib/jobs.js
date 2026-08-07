/* ============================================================
   Cron

   What ran on setInterval in the container.

   Triggers fire in UTC and Alberta observes daylight saving, so
   every job works out the local date itself. A rent run that fires
   on the wrong side of midnight bills the wrong month, and it does
   it silently.
   ============================================================ */

/** The date in Edmonton, whatever UTC thinks. */
export function albertaToday(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

export async function runDailyJobs(sql, env) {
  const today = albertaToday();
  const results = {};

  try {
    // Idempotent by design, so a retry after a failure adds nothing rather
    // than billing 330 tenants twice.
    results.rent = await dailyRentRun(sql, today);
    results.renewals = await scanRenewals(sql, today);
    results.refunds = await scanRefundDeadlines(sql, today);
    results.passwords = await passwordExpiryWarnings(sql, today);
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

/* ---------- The jobs themselves ---------- */

async function dailyRentRun(sql, today) {
  const period = today.slice(0, 7);
  const day = Number(today.slice(8, 10));

  const due = await sql`
    SELECT * FROM charge_schedules
    WHERE is_active AND charge_day = ${day}
      AND start_date <= ${today}
      AND (end_date IS NULL OR end_date >= ${today})
      AND NOT EXISTS (
        SELECT 1 FROM ar_charges c
        WHERE c.schedule_id = charge_schedules.id AND c.period = ${period})`;

  if (!due.length) return { raised: 0 };

  // One transaction for the run. A partial rent run is worse than none:
  // half the building billed and nobody sure which half.
  let raised = 0;
  await sql.begin(async (tx) => {
    for (const s of due) {
      await tx`SELECT rent_run_charge(${s.id}, ${period})`;
      raised++;
    }
  });
  return { raised, period };
}

async function scanRenewals(sql, today) {
  const horizon = new Date(new Date(today).getTime() + 90 * 864e5)
    .toISOString().slice(0, 10);
  const rows = await sql`
    SELECT id, unit_number, end_date FROM leases
    WHERE status = 'active' AND end_date IS NOT NULL
      AND end_date BETWEEN ${today} AND ${horizon}
      AND NOT EXISTS (SELECT 1 FROM renewal_tasks r WHERE r.lease_id = leases.id)`;
  for (const l of rows)
    await sql`INSERT INTO renewal_tasks (id, lease_id, unit_number, state)
              VALUES (gen_random_uuid()::text, ${l.id}, ${l.unit_number}, 'open')
              ON CONFLICT DO NOTHING`;
  return { flagged: rows.length };
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
 * Delivery. Queued messages go out here rather than from the request that
 * caused them, so a provider outage delays a message instead of losing it
 * with nobody knowing which ones went missing.
 */
async function drainOutbox(sql, env, limit) {
  const rows = await sql`
    SELECT * FROM outbox WHERE state = 'queued' AND attempts < 5
    ORDER BY created_at LIMIT ${limit}`;
  if (!rows.length) return { attempted: 0, sent: 0 };

  let sent = 0;
  for (const row of rows) {
    try {
      if (!env.RESEND_API_KEY) {
        // No provider. Recorded as unattempted rather than failed, because a
        // message nobody tried to send is a different problem from one that
        // bounced.
        await sql`UPDATE outbox SET attempts = attempts + 1,
          last_error = 'No delivery provider configured' WHERE id = ${row.id}`;
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
        }),
      });

      if (!res.ok) throw new Error(`EMAIL_${res.status}`);
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

  // Anything past the time it had to go out. This is the number worth an
  // alert: a notice of entry that never left looks identical to one that did.
  const [{ count: overdue }] = await sql`
    SELECT COUNT(*)::int AS count FROM outbox
    WHERE state='queued' AND required_by IS NOT NULL AND required_by < now()`;
  if (overdue > 0) console.warn(`[outbox] ${overdue} past their deadline`);

  return { attempted: rows.length, sent, overdue };
}
