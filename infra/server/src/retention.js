import { db, nowISO } from "./db.js";

/* ============================================================
   Data retention

   Alberta PIPA expects personal information to be kept only as long
   as it is needed, with a defined period actually enforced — not a
   sentence in a policy document.

   The periods below are defaults, not law. They are separated by
   what the data is for:

     A lead who never became a tenant is marketing data. Twelve
     months is generous.

     A tenancy record has to survive long enough to answer a claim.
     Alberta's limitation period runs two years from discovery, with
     a ten-year long stop, so seven years past the end of a tenancy
     is the usual compromise.

     Financial records follow CRA: six years after the tax year they
     relate to.

   Nothing here deletes a file behind a deposit deduction. Rows go;
   the evidence somebody may have to defend does not.
   ============================================================ */

export const POLICIES = [
  { code: "leads_unconverted", label: "Leads that never converted",
    months: 12, table: "leads",
    describe: "Marketing data. A lead who did not rent has no ongoing reason to be on file." },

  { code: "showing_requests", label: "Viewing requests",
    months: 12, table: "showing_requests",
    describe: "Kept alongside the lead they belong to." },

  { code: "applications_declined", label: "Declined applications",
    months: 24, table: "applications",
    describe: "Two years covers the window in which a human rights complaint could be brought, which is exactly when this record is worth having." },

  { code: "messages", label: "Tenant messages",
    months: 36, table: "outbox",
    describe: "Correspondence, kept long enough to answer a dispute about what was said." },

  { code: "escalations", label: "Escalated threads",
    months: 36, table: "escalations" },

  { code: "confirmations", label: "Confirmation tokens",
    months: 6, table: "confirmations",
    describe: "Short-lived by design. The booking they belong to is kept separately." },

  { code: "leases", label: "Ended tenancies",
    months: 84, table: "leases",
    describe: "Seven years past the end. Alberta's limitation period is two years from discovery with a ten-year long stop; this is the usual compromise." },

  { code: "financial", label: "Accounting records",
    months: 72, table: "journal_entries",
    describe: "Six years after the tax year, per CRA. Not deleted automatically — see below." },
];

/* Some things are never pruned by a job, whatever the period says. Deleting
   them is a decision somebody makes, not something that happens overnight. */
export const NEVER_AUTO = new Set(["financial", "leases"]);

function policyFor(code) {
  return POLICIES.find((p) => p.code === code);
}

const cutoff = (months) =>
  new Date(Date.now() - months * 30.44 * 864e5).toISOString().slice(0, 10);

/** What would go, without touching anything. Retention should be visible
 *  before it runs: a job that quietly deletes is a job nobody trusts. */
export function preview() {
  const out = [];

  const leadCut = cutoff(policyFor("leads_unconverted").months);
  out.push({ code: "leads_unconverted",
    count: db.prepare(`SELECT COUNT(*) n FROM leads
      WHERE stage IN ('lost') AND date(COALESCE(last_contact_at, created_at)) < ?`)
      .get(leadCut).n, cutoff: leadCut });

  const srCut = cutoff(policyFor("showing_requests").months);
  out.push({ code: "showing_requests",
    count: db.prepare(`SELECT COUNT(*) n FROM showing_requests
      WHERE date(created_at) < ? AND state IN ('completed','cancelled','declined')`)
      .get(srCut).n, cutoff: srCut });

  const appCut = cutoff(policyFor("applications_declined").months);
  out.push({ code: "applications_declined",
    count: db.prepare(`SELECT COUNT(*) n FROM applications
      WHERE state IN ('declined','withdrawn') AND date(created_at) < ?`)
      .get(appCut).n, cutoff: appCut });

  const msgCut = cutoff(policyFor("messages").months);
  out.push({ code: "messages",
    count: db.prepare(`SELECT COUNT(*) n FROM outbox WHERE date(created_at) < ?`)
      .get(msgCut).n, cutoff: msgCut });

  const escCut = cutoff(policyFor("escalations").months);
  out.push({ code: "escalations",
    count: db.prepare(`SELECT COUNT(*) n FROM escalations
      WHERE state IN ('answered','closed') AND date(created_at) < ?`)
      .get(escCut).n, cutoff: escCut });

  const cfCut = cutoff(policyFor("confirmations").months);
  out.push({ code: "confirmations",
    count: db.prepare(`SELECT COUNT(*) n FROM confirmations WHERE date(created_at) < ?`)
      .get(cfCut).n, cutoff: cfCut });

  return out.map((x) => ({ ...x, ...policyFor(x.code),
    auto: !NEVER_AUTO.has(x.code) }));
}

/**
 * Runs the policies that delete automatically.
 *
 * A lead is anonymised rather than removed: the funnel numbers stay
 * meaningful, and what goes is the part that identifies somebody. Deleting the
 * row outright would quietly rewrite last year's conversion rate.
 */
export function run({ dryRun = false, actor = "system" } = {}) {
  const results = [];
  const record = (code, action, count) => results.push({ code, action, count });

  const leadCut = cutoff(policyFor("leads_unconverted").months);
  const staleLeads = db.prepare(`SELECT id FROM leads
    WHERE stage='lost' AND date(COALESCE(last_contact_at, created_at)) < ?
      AND (email IS NOT NULL OR phone IS NOT NULL)`).all(leadCut);
  if (!dryRun && staleLeads.length) {
    const anon = db.prepare(`UPDATE leads SET name='(removed)', email=NULL, phone=NULL,
      contact_id=NULL WHERE id=?`);
    const notes = db.prepare("DELETE FROM lead_notes WHERE lead_id=?");
    db.transaction(() => {
      for (const l of staleLeads) { anon.run(l.id); notes.run(l.id); }
    })();
  }
  record("leads_unconverted", "anonymised", staleLeads.length);

  const srCut = cutoff(policyFor("showing_requests").months);
  const sr = db.prepare(`SELECT COUNT(*) n FROM showing_requests
    WHERE date(created_at) < ? AND state IN ('completed','cancelled','declined')`).get(srCut).n;
  if (!dryRun && sr) db.prepare(`UPDATE showing_requests SET name='(removed)', email=NULL,
    phone=NULL, notes=NULL WHERE date(created_at) < ?
    AND state IN ('completed','cancelled','declined')`).run(srCut);
  record("showing_requests", "anonymised", sr);

  const appCut = cutoff(policyFor("applications_declined").months);
  const apps = db.prepare(`SELECT id FROM applications
    WHERE state IN ('declined','withdrawn') AND date(created_at) < ?`).all(appCut);
  if (!dryRun && apps.length) {
    // Uploaded identity documents go with the application. Those are the most
    // sensitive thing collected and the least defensible to keep.
    const docs = db.prepare("DELETE FROM application_documents WHERE application_id=?");
    const anon = db.prepare(`UPDATE applications SET tenants='[]', email=NULL, phone=NULL
      WHERE id=?`);
    db.transaction(() => {
      for (const a of apps) { docs.run(a.id); anon.run(a.id); }
    })();
  }
  record("applications_declined", "anonymised, documents removed", apps.length);

  const msgCut = cutoff(policyFor("messages").months);
  const msgs = db.prepare(`SELECT COUNT(*) n FROM outbox WHERE date(created_at) < ?`)
    .get(msgCut).n;
  if (!dryRun && msgs) db.prepare(`UPDATE outbox SET body='(removed under retention)',
    to_email=NULL, to_phone=NULL WHERE date(created_at) < ?`).run(msgCut);
  record("messages", "content removed, delivery record kept", msgs);

  const cfCut = cutoff(policyFor("confirmations").months);
  const cf = db.prepare(`SELECT COUNT(*) n FROM confirmations WHERE date(created_at) < ?`)
    .get(cfCut).n;
  if (!dryRun && cf) db.prepare(`DELETE FROM confirmations WHERE date(created_at) < ?`).run(cfCut);
  record("confirmations", "deleted", cf);

  const total = results.reduce((t, r) => t + r.count, 0);
  if (!dryRun && total > 0) {
    // Retention is itself a change to the record. A log that cannot show what
    // was removed cannot show that the policy was followed either.
    db.prepare(`INSERT INTO audit_log (actor_name, action, entity_type, after_value)
      VALUES (?, 'retention.run', 'system', ?)`)
      .run(actor, JSON.stringify({ results, at: nowISO() }));
    console.log(`[retention] ${total} record(s) processed`);
  }
  return { dry_run: dryRun, results, total };
}
