import { Router } from "express";
import { db, uid, nowISO } from "../db.js";
import { authenticate, require_, audit } from "../rbac.js";

const r = Router();

/* ============================================================
   AI proxy

   Every model call goes through here rather than from the browser.
   Three reasons, in order of how badly each one bites:

   The API key. Called from the browser it ends up in the bundle,
   which means anyone who opens developer tools has it.

   The audit trail. A draft that went to a tenant should be traceable
   to a request, a person and a moment. A call made from a laptop
   leaves nothing behind.

   The prompt. Held on the server it is one thing that can be reviewed
   and changed. Shipped to the browser it is whatever version that
   user last loaded.

   The task decides the prompt. A caller says what it wants done and
   supplies facts; it does not get to send arbitrary instructions to
   the model under this system's key.

   There is no task that writes or reformats an agreement. Admin
   uploads the file counsel approved and that file is what the tenant
   signs — a generated clause can be void and reads exactly as
   convincingly as a valid one.
   ============================================================ */

const MODEL = "claude-sonnet-4-6";
const API = "https://api.anthropic.com/v1/messages";

/* Per-user, per-hour. Not a security boundary — it is there so a loop in a
   component cannot quietly spend a month's budget in an afternoon. */
const RATE_PER_HOUR = 120;
const recent = new Map();

function withinRate(userId) {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < 3600e3);
  hits.push(now);
  recent.set(userId, hits);
  return hits.length <= RATE_PER_HOUR;
}

/* ---------- Tasks ----------
   Each is a fixed prompt with a fixed shape of input. Adding a capability
   means adding a task here, where it can be read. */

const TASKS = {
  /* Classifies a tenant message and drafts a reply. The facts block is the
     only source: anything not in it must be declined rather than guessed. */
  inbox_draft: {
    permission: "inbox.manage",
    maxTokens: 1500,
    build: ({ facts, message, channel, intents }) =>
`You draft replies for the Baydo Pointe leasing team in Alberta, Canada. Below is the property data as it stands right now. It is your only source of facts.

${facts}

Tenant message (channel: ${channel ?? "email"}):
${message}

Rules:
1. Every amount, date, count and unit number in the reply must appear in the facts above. Never calculate, estimate or fill a gap.
2. If something is marked as not set, or is absent, do not invent it. Name what is missing in missing_info and say in the draft that you will confirm and come back to them.
3. Never promise to hold a unit, negotiate, quote lease terms, or answer questions about who qualifies.
4. For a viewing or signing request, confirm only that a slot is being booked and a confirmation will follow. Never invent a specific time.
5. Reply in the language the tenant wrote in: Traditional Chinese for a Chinese message, English for an English one. Keep SMS under 300 characters.
6. Professional and warm, not salesy. End by noting this is an automated reply and a person is available.
7. After any amount, note that the signed lease governs.

intent must be one of: ${(intents ?? []).join(", ")}

Reply with JSON only, no markdown:
{"intent":"...","confidence":0.0,"facts_used":["which facts you used"],"missing_info":null or "what is missing","draft":"the full reply"}`,
  },

  /* Asks the next intake question. Protected grounds are excluded in the
     prompt and checked again by rule after the response comes back. */
  intake_question: {
    permission: "lease.sign",
    maxTokens: 900,
    build: ({ fields, known, reply }) =>
`You help a leasing agent collect the details needed before a lease is prepared. This is a residential tenancy in Alberta, Canada.

Required fields:
${fields}

Known so far:
${known}

The tenant's latest reply:
${reply || "(nothing yet — ask the first question)"}

Rules:
1. Extract any field you can confirm from the reply into extracted. If it is not certain, leave it out.
2. Option fields must match the listed strings exactly. Never invent one.
3. Ask about one unconfirmed field at a time, in the language the tenant used.
4. Never ask about household composition, children, marital status, nationality, immigration status, religion, race, age, gender, income, employment, credit or any assistance program. The number of occupants is fine, because that is an occupancy standard. Who they are is not.
5. Do not explain lease terms, negotiate, or promise anything.
6. Never state an amount. The costs are assembled by the system and sent separately. If they ask, say the full breakdown is coming.
7. When every field is confirmed, set next_question to null and done to true.

Reply with JSON only, no markdown:
{"extracted":{"field":"value"},"next_question":"the next question, or null","done":false}`,
  },



  /* A notice of entry, in both languages, from fixed facts. */
  entry_notice: {
    permission: "entrynotice.manage",
    maxTokens: 1200,
    build: ({ unit, layout, tenant, date, from, to, purpose, issued }) =>
`You manage residential property in Alberta, Canada. Write a notice of entry for a tenant who still lives in the unit.

Purpose: ${purpose}.

Facts. Use only these, add nothing:
- Unit: ${unit}${layout ? ` (${layout})` : ""}
- Tenant: ${tenant || "the tenant"}
- Date of entry: ${date}
- Time window: ${from} to ${to}
- Accompanied by property staff
- Notice issued: ${issued}

Requirements:
1. Write it twice, English first then Traditional Chinese, with identical content. This goes to a tenant, so both languages are required.
2. State the date, the time window, the purpose and who will accompany.
3. Polite and brief. No sales language, and do not ask the tenant to tidy up.
4. Say the tenant can reply to arrange a different time if this one is difficult.
5. Do not cite or claim any statute or section number.
6. No filler beyond a heading. Under 200 words across both languages.

Output the notice text only, with no commentary and no markdown.`,
  },

  /* Commentary on a monthly report. The figures are computed in SQL and
     passed in; the model is told not to recalculate them. */
  report_narrative: {
    permission: "accounting.reports",
    maxTokens: 1200,
    build: ({ building, figures, method }) =>
`You write the commentary on a monthly property report for building ${building} at Baydo Pointe, a residential rental in Edmonton, Alberta.

The figures below were computed from posted, reconciled ledger entries. They are final.

FIGURES
${JSON.stringify(figures, null, 2)}

HOW EACH FIGURE WAS DERIVED
${method}

Rules:
1. Never recalculate, adjust or round anything. Quote the figures exactly as given.
2. Never introduce a number that is not in the figures above.
3. Say what the numbers show and what is worth attention. Do not speculate about causes you cannot see in the data.
4. If arrears or collection moved in a direction worth noticing, say so plainly.
5. No recommendations about rent levels, and nothing about individual tenants.
6. Four short paragraphs at most. Plain English, no jargon, no bullet points.
7. End with one sentence naming the single thing most worth looking at next month.

Write the commentary only. No heading, no preamble, no markdown.`,
  },

  /* One sentence describing a change, from the recorded diff. */
  change_narrative: {
    permission: "accounting.post",
    maxTokens: 300,
    build: ({ summary, entity, entityId, by, at, reason, changed }) =>
`Describe one accounting change in a single plain sentence, for a change log a bookkeeper will read.

CHANGE
What: ${summary}
Record: ${entity} ${entityId}
By: ${by} at ${at}
Reason given: ${reason ?? "(none recorded)"}
Fields that moved: ${JSON.stringify(changed ?? [], null, 2)}

Rules:
1. State what changed and by how much, using the exact figures above.
2. Never introduce a number that is not above.
3. Include the recorded reason. If none was recorded, say so rather than inventing one.
4. One sentence. No preamble, and no judgement about whether it was correct.

Write the sentence only.`,
  },

  /* Looks up the deposit interest rate. Told to admit uncertainty, because
     a confident wrong rate here is not discovered until a refund is short. */
  interest_rate: {
    permission: "accounting.post",
    maxTokens: 1200,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    build: ({ year }) =>
`Find the security deposit interest rate for ${year} in Alberta, Canada.

Under the Residential Tenancies Act, a landlord holding a security deposit must pay interest at the rate set by the Security Deposit Interest Rate Regulation. The rate is prescribed annually.

Rules:
1. If you are not certain of the published figure for ${year}, say so and set confidence to "unverified". A confident wrong rate makes every deposit refund wrong, and it is not discovered until a tenant moves out.
2. Do not interpolate from other years and do not estimate. Either you have the published figure or you do not.
3. Give the rate as a decimal: 0.02 for 2%, 0.0 for zero.
4. This rate has been set at zero for a long stretch of recent years. If that is what you find, report zero plainly rather than treating it as an error.
5. Name a source a person can check.

Reply with JSON only, no markdown:
{"year":${year},"rate":0.0,"confidence":"high|low|unverified","source_text":"what the source says","source_url":"where to verify","reasoning":"one or two sentences, including what a person should confirm"}`,
  },

  /* Advises staff on parking allocation. The shortfall is structural — 222
     stalls against 330 units — so the useful answers are about policy, not
     about finding stalls that do not exist. */
  parking_advice: {
    permission: "parking.allocate",
    maxTokens: 900,
    build: ({ state, question }) =>
`You advise the leasing team at Baydo Pointe in Edmonton, Alberta on parking.

Current position:
${state}

Question: ${question}

Rules:
1. Use only the numbers above. Never estimate or invent a figure.
2. The shortfall is structural: there are fewer stalls than units and no more can be built. Do not suggest finding extra stalls.
3. Allocation is first come, first served by request time. Do not suggest prioritising by rent paid, by unit type, or by anything about the tenant — allocating scarce parking on a discretionary basis is where a fair housing problem starts.
4. If the answer is that somebody has to wait, say so plainly rather than softening it.
5. Three short paragraphs at most. No bullet points.

Write the answer only.`,
  },

  /* Answers a prospective tenant on the public site. The only task that can
     reach someone without a person in between, which is why the hard stops
     run before it. */
  tenant_chat: {
    permission: null,          // public, rate limited by IP
    maxTokens: 900,
    build: ({ facts, history, message, language }) =>
`You answer questions from prospective tenants on the Baydo Pointe website. Below is the live property data. It is your only source of facts.

${facts}

Recent conversation:
${history}
Tenant: ${message}

Rules:
1. Every number, date and unit reference must appear in the data above. Never calculate, estimate or fill a gap.
2. If something is marked "not set" or is absent, say you will check and come back to them. Do not invent it.
3. Never promise to hold a unit, negotiate, quote lease terms, or answer questions about who qualifies.
4. Never state a rent or fee that is not in the data.
5. Reply in ${language === "zh" ? "Traditional Chinese" : "English"}, matching the tenant.
6. Two or three sentences. Warm and direct, not salesy. No greeting boilerplate.
7. If you cannot answer from the data, say so plainly and offer to pass it to a colleague.

Reply with the message text only. No preamble, no markdown.`,
  },
};

async function callModel(task, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("AI_NOT_CONFIGURED"), { status: 503 });

  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key,
               "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: task.maxTokens ?? 1000,
      ...(task.tools ? { tools: task.tools } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error("AI_UPSTREAM_ERROR"),
      { status: 502, upstream: res.status, detail: detail.slice(0, 400) });
  }

  const data = await res.json();
  const text = (data.content ?? []).filter((c) => c.type === "text")
    .map((c) => c.text).join("").trim();
  return { text, usage: data.usage ?? null };
}

/** Every call is recorded: the task, who asked, how long it took, and whether
 *  it came back. Not the prompt or the response — those hold tenant messages
 *  and belong in the record for the thing they were about, not here. */
function recordCall(req, { taskName, refType, refId, ok, ms, usage, error }) {
  audit(req, {
    action: `ai.${taskName}`, entityType: refType ?? "ai", entityId: refId ?? null,
    after: { ok, ms, input_tokens: usage?.input_tokens ?? null,
             output_tokens: usage?.output_tokens ?? null, error: error ?? null },
  });
}

/* ---------- Public: tenant chat ---------- */
/* No session. Rate limited by address, because the alternative is either an
   account wall in front of "how much is rent" or an open budget. */

const publicHits = new Map();
function publicRate(ip) {
  const now = Date.now();
  const hits = (publicHits.get(ip) ?? []).filter((t) => now - t < 3600e3);
  hits.push(now);
  publicHits.set(ip, hits);
  return hits.length <= 40;
}

r.post("/public/ai/chat", async (req, res) => {
  if (!publicRate(req.ip)) return res.status(429).json({ code: "RATE_LIMITED" });
  const { facts, history, message, language } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ code: "MESSAGE_REQUIRED" });

  const task = TASKS.tenant_chat;
  const started = Date.now();
  try {
    const out = await callModel(task, task.build({ facts, history, message, language }));
    db.prepare(`INSERT INTO audit_log (actor_name, action, entity_type, ip)
      VALUES ('public','ai.tenant_chat','ai',?)`).run(req.ip);
    res.json({ text: out.text, ms: Date.now() - started });
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, upstream: e.upstream });
  }
});

/* ---------- Everything else needs a session ---------- */
r.use(authenticate);

r.get("/ai/tasks", (req, res) => {
  res.json({
    configured: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    tasks: Object.entries(TASKS).map(([name, t]) => ({
      name, permission: t.permission,
      allowed: !t.permission || req.user.perms.has(t.permission) })),
  });
});

r.post("/ai/:task", async (req, res) => {
  const name = req.params.task;
  const task = TASKS[name];
  if (!task) return res.status(404).json({ code: "UNKNOWN_TASK", task: name });
  if (task.permission && !req.user.perms.has(task.permission))
    return res.status(403).json({ code: "FORBIDDEN", needs: task.permission });
  if (!withinRate(req.user.id)) return res.status(429).json({ code: "RATE_LIMITED" });

  const started = Date.now();
  try {
    const prompt = task.build(req.body?.input ?? {});
    const out = await callModel(task, prompt);
    recordCall(req, { taskName: name, refType: req.body?.ref_type, refId: req.body?.ref_id,
                      ok: true, ms: Date.now() - started, usage: out.usage });
    res.json({ text: out.text, ms: Date.now() - started });
  } catch (e) {
    recordCall(req, { taskName: name, refType: req.body?.ref_type, refId: req.body?.ref_id,
                      ok: false, ms: Date.now() - started, error: e.message });
    res.status(e.status ?? 500).json({ code: e.message, upstream: e.upstream,
                                        detail: e.detail });
  }
});

export default r;
