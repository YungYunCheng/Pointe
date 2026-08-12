import { Hono } from "hono";
import { audit } from "../lib/auth.js";

const r = new Hono();

const PROMPTS = {
  inbox_draft: `Classify a property-management message and draft a concise reply using only the supplied facts. Output JSON only: {"intent":"one supplied intent","confidence":0.0,"draft":"reply","facts_used":[],"missing_info":null}. Never invent prices, availability, policy, legal conclusions, or promises. If facts are missing, say so in missing_info.`,
  intake_question: `Help collect lease-intake fields. Extract only clearly stated values. Ask one neutral question at a time and do not ask about protected personal characteristics. Output JSON only: {"extracted":{},"next_question":"question or null","done":false}.`,
  template_fields: `Identify fillable fields explicitly present in the supplied approved document text. Output a JSON array only. Each item must have key, label, source_text and confidence. Do not add clauses or legal language.`,
  document_convert: `Reformat the supplied document content for the requested operational target without changing its meaning, amounts, clauses, or obligations. Return only the converted content.`,
  entry_notice: `Draft a clear bilingual English and Traditional Chinese notice of entry using only the supplied unit, date, time window and purpose. Do not add legal claims or change the time. Return notice text only for staff review.`,
  purchase_order: `Draft a purchase-order description, scope and expense lines from the maintenance facts. Output JSON only with description, scope, gl_code, lines and needs_quote. Amounts must be blank unless a vendor quote is supplied.`,
  parking_advice: `Analyse the supplied parking allocation facts. Explain operational risks and practical next checks without inventing availability or policy. Return concise staff guidance.`,
  report_narrative: `Turn the supplied accounting figures into a concise factual management narrative. Do not change or infer figures. Flag missing comparisons.`,
  public_chat: `Answer a prospective tenant using only the supplied public property data and approved company rules. Reply in the visitor's language. Never invent or guarantee availability, rent, fees, parking, dates, policies, approval, a reservation or an outcome. Counts are a current snapshot and may change. If the answer is not present, say the leasing team must confirm it. Do not reveal unit numbers, tenant information, leases, payments, vehicle information or internal notes. Keep the answer concise and do not output JSON.`,
};

const adminOnly = async (c, next) => {
  if (c.get("user")?.role !== "admin") return c.json({ code: "FORBIDDEN" }, 403);
  return next();
};

const clipped = (value, max = 4000) => String(value ?? "").slice(0, max);

async function trainingContext(c, task) {
  try {
    const rules = await c.get("db")`
      SELECT title, instruction, task
      FROM ai_training_rules
      WHERE is_active = TRUE AND (task IS NULL OR task = ${task})
      ORDER BY CASE WHEN task = ${task} THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 20`;
    const examples = await c.get("db")`
      SELECT original_input, approved_output
      FROM ai_feedback_examples
      WHERE review_status = 'approved' AND task = ${task}
      ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
      LIMIT 4`;
    const sections = [];
    if (rules.length) sections.push("Company rules:\n" + rules
      .map((x) => `- ${clipped(x.title, 120)}: ${clipped(x.instruction, 1200)}`).join("\n"));
    if (examples.length) sections.push("Approved examples (follow the approach, not private facts):\n" + examples
      .map((x, i) => `Example ${i + 1}\nInput: ${clipped(x.original_input)}\nApproved output: ${clipped(x.approved_output)}`)
      .join("\n\n"));
    return sections.join("\n\n");
  } catch (error) {
    // Migration 018 may not have been applied yet. AI stays available with
    // its base prompt instead of turning a pending admin setup into downtime.
    console.warn("[ai-training-context]", error?.message ?? error);
    return "";
  }
}

/** A deliberately narrow, public snapshot. The model never receives rows
 * containing tenants, leases, payments, vehicles, unit numbers or notes. */
async function publicPropertyFacts(sql) {
  const types = await sql`
    SELECT replace(u.unit_type_code, ' (M)', '') AS code,
      MIN(t.bedroom_label_en) AS label_en,
      MIN(t.bedroom_label_zh) AS label_zh,
      MIN(t.area_sqft) AS area_sqft,
      COUNT(*) FILTER (WHERE u.status = 'available')::int AS available,
      MIN(u.available_from) FILTER (WHERE u.status = 'available') AS earliest,
      MIN(COALESCE(u.rent_override, r.base_rent))
        FILTER (WHERE u.status = 'available') AS rent_from,
      MAX(COALESCE(u.rent_override, r.base_rent))
        FILTER (WHERE u.status = 'available') AS rent_to
    FROM units u
    JOIN unit_types t ON t.code = u.unit_type_code
    LEFT JOIN pricing_profiles p
      ON p.effective_from <= CURRENT_DATE
     AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    LEFT JOIN unit_type_rents r
      ON r.pricing_profile_id = p.id AND r.unit_type_code = u.unit_type_code
    GROUP BY replace(u.unit_type_code, ' (M)', '')
    ORDER BY MIN(t.area_sqft)`;

  const parking = await sql`
    SELECT p.code, p.label_en, p.label_zh, p.is_surface,
      p.total_stalls,
      COUNT(a.id) FILTER (WHERE a.status = 'assigned')::int AS assigned,
      GREATEST(p.total_stalls -
        COUNT(a.id) FILTER (WHERE a.status = 'assigned')::int, 0) AS available,
      COUNT(a.id) FILTER (WHERE a.status = 'waiting')::int AS waiting
    FROM parking_pools p
    LEFT JOIN parking_allocations a ON a.pool_code = p.code
    GROUP BY p.code, p.label_en, p.label_zh, p.is_surface, p.total_stalls
    ORDER BY p.is_surface, p.code`;

  const [fees] = await sql`
    SELECT f.deposit_mode, f.deposit_fixed, f.cat_deposit, f.dog_deposit,
      f.pet_rent, f.pet_limit, f.parking_underground, f.parking_surface,
      f.storage_fee, f.application_fee, f.utilities_included
    FROM fee_settings f
    JOIN pricing_profiles p ON p.id = f.pricing_profile_id
    WHERE p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    ORDER BY p.effective_from DESC LIMIT 1`;

  return {
    property: "Baydo Pointe, Clareview, Edmonton",
    snapshot_at: new Date().toISOString(),
    unit_types: types,
    parking,
    fees: fees ?? null,
  };
}

function responseText(result) {
  return (result.output ?? [])
    .flatMap((item) => item.type === "message" ? (item.content ?? []) : [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "").join("\n");
}

/* Human-approved examples are training candidates, not live instructions.
   They remain pending until an administrator explicitly approves or excludes
   them in the Training Center. This specific route must precede /ai/:task. */
r.post("/ai/feedback", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const original = String(body.original ?? "").trim();
  const draft = String(body.draft ?? "").trim();
  const final = String(body.final ?? "").trim();
  if (!body.task || !original || !draft || !final)
    return c.json({ code: "MISSING_FIELDS" }, 400);
  if ([original, draft, final].some((value) => value.length > 20_000))
    return c.json({ code: "AI_FEEDBACK_TOO_LARGE" }, 413);

  const [row] = await c.get("db")`
    INSERT INTO ai_feedback_examples (id, task, source_ref_type, source_ref_id,
      original_input, ai_draft, approved_output, was_edited, model, created_by)
    VALUES (${`aif_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`},
      ${body.task}, ${body.ref_type ?? null}, ${body.ref_id ?? null}, ${original},
      ${draft}, ${final}, ${draft !== final},
      ${body.model ?? c.env.OPENAI_MODEL ?? "gpt-5.6-luna"}, ${c.get("user").id})
    RETURNING id, was_edited, created_at`;
  await audit(c, { action: "ai.feedback.captured", entityType: "ai_feedback",
    entityId: row.id, after: { task: body.task, was_edited: row.was_edited,
      review_status: "pending" } });
  return c.json({ feedback: row }, 201);
});

r.get("/admin/ai-training", adminOnly, async (c) => {
  const status = c.req.query("status") ?? "all";
  const task = c.req.query("task") ?? "all";
  const q = (c.req.query("q") ?? "").trim();
  const examples = await c.get("db")`
    SELECT f.id, f.task, f.source_ref_type, f.source_ref_id, f.original_input,
      f.ai_draft, f.approved_output, f.was_edited, f.model, f.review_status,
      f.exclusion_reason, f.created_at, f.reviewed_at,
      creator.full_name AS created_by_name, reviewer.full_name AS reviewed_by_name
    FROM ai_feedback_examples f
    LEFT JOIN users creator ON creator.id = f.created_by
    LEFT JOIN users reviewer ON reviewer.id = f.reviewed_by
    WHERE (${status} = 'all' OR f.review_status = ${status})
      AND (${task} = 'all' OR f.task = ${task})
      AND (${q} = '' OR f.original_input ILIKE ${`%${q}%`}
        OR f.approved_output ILIKE ${`%${q}%`})
    ORDER BY f.created_at DESC LIMIT 200`;
  const stats = await c.get("db")`
    SELECT review_status, COUNT(*)::int AS count
    FROM ai_feedback_examples GROUP BY review_status`;
  const rules = await c.get("db")`
    SELECT r.*, u.full_name AS updated_by_name
    FROM ai_training_rules r LEFT JOIN users u ON u.id = r.updated_by
    ORDER BY r.is_active DESC, r.updated_at DESC`;
  return c.json({ examples, stats, rules });
});

r.patch("/admin/ai-training/examples/:id", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!["pending", "approved", "excluded"].includes(body.status))
    return c.json({ code: "INVALID_STATUS" }, 400);
  const [before] = await c.get("db")`
    SELECT id, review_status, exclusion_reason FROM ai_feedback_examples
    WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const reason = body.status === "excluded" ? clipped(body.reason, 500).trim() || null : null;
  const [row] = await c.get("db")`
    UPDATE ai_feedback_examples SET review_status = ${body.status},
      reviewed_by = ${c.get("user").id}, reviewed_at = now(),
      excluded_at = ${body.status === "excluded" ? new Date().toISOString() : null},
      exclusion_reason = ${reason}
    WHERE id = ${before.id}
    RETURNING id, review_status, reviewed_at, exclusion_reason`;
  await audit(c, { action: "ai.training.review", entityType: "ai_feedback",
    entityId: row.id, before, after: row });
  return c.json({ example: row });
});

r.post("/admin/ai-training/rules", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = clipped(body.title, 120).trim();
  const instruction = clipped(body.instruction, 4000).trim();
  if (!title || !instruction) return c.json({ code: "MISSING_FIELDS" }, 400);
  const id = `air_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [row] = await c.get("db")`
    INSERT INTO ai_training_rules (id, title, instruction, task, created_by, updated_by)
    VALUES (${id}, ${title}, ${instruction}, ${body.task || null},
      ${c.get("user").id}, ${c.get("user").id}) RETURNING *`;
  await audit(c, { action: "ai.training.rule.create", entityType: "ai_training_rule",
    entityId: id, after: row });
  return c.json({ rule: row }, 201);
});

r.patch("/admin/ai-training/rules/:id", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const [before] = await c.get("db")`
    SELECT * FROM ai_training_rules WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const title = body.title == null ? before.title : clipped(body.title, 120).trim();
  const instruction = body.instruction == null ? before.instruction : clipped(body.instruction, 4000).trim();
  if (!title || !instruction) return c.json({ code: "MISSING_FIELDS" }, 400);
  const [row] = await c.get("db")`
    UPDATE ai_training_rules SET title = ${title}, instruction = ${instruction},
      task = ${body.task === undefined ? before.task : body.task || null},
      is_active = ${body.is_active === undefined ? before.is_active : !!body.is_active},
      updated_by = ${c.get("user").id}, updated_at = now()
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "ai.training.rule.update", entityType: "ai_training_rule",
    entityId: row.id, before, after: row });
  return c.json({ rule: row });
});

/** Public tenant/prospect chat. Rate limiting is applied by the global
 * /api/public middleware before this handler runs. */
r.post("/public/ai/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = clipped(body.message, 2000).trim();
  const history = clipped(body.history, 5000).trim();
  const language = body.language === "zh" ? "Traditional Chinese" : "English";
  if (!message) return c.json({ code: "MESSAGE_REQUIRED" }, 400);
  if (!c.env.OPENAI_API_KEY) return c.json({ code: "AI_NOT_CONFIGURED" }, 503);

  try {
    const [facts, learned] = await Promise.all([
      publicPropertyFacts(c.get("db")), trainingContext(c, "public_chat"),
    ]);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${c.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: c.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        max_output_tokens: 500,
        reasoning: { effort: "low" },
        instructions: PROMPTS.public_chat + (learned ? `\n\n${learned}` : ""),
        input: [{ role: "user", content:
          `Reply language: ${language}\nRecent conversation:\n${history || "None"}` +
          `\n\nCurrent public database snapshot:\n${JSON.stringify(facts)}` +
          `\n\nVisitor question:\n${message}` }],
      }),
    });
    if (!response.ok) {
      const detail = clipped(await response.text().catch(() => ""), 500);
      console.error("[public-ai]", response.status, detail);
      return c.json({ code: "AI_PROVIDER_ERROR" }, 502);
    }
    const result = await response.json();
    const text = responseText(result).trim();
    if (!text) return c.json({ code: "AI_EMPTY_RESPONSE" }, 502);
    return c.json({ text, model: result.model, snapshot_at: facts.snapshot_at });
  } catch (error) {
    console.error("[public-ai]", error?.message ?? error);
    return c.json({ code: "AI_CHAT_ERROR" }, 500);
  }
});

r.post("/ai/:task", async (c) => {
  const task = c.req.param("task");
  const body = await c.req.json().catch(() => ({}));
  const input = body.input ?? {};
  const encoded = JSON.stringify(input);
  if (encoded.length > 80_000) return c.json({ code: "AI_INPUT_TOO_LARGE" }, 413);
  if (!c.env.OPENAI_API_KEY) return c.json({ code: "AI_NOT_CONFIGURED" }, 503);

  const learned = await trainingContext(c, task);
  const system = (PROMPTS[task] ??
    `Assist a property-management employee with the named task. Use only supplied facts, do not take actions, move money, make legal decisions, or promise an outcome. Return a draft for human review.`)
    + (learned ? `\n\n${learned}` : "");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${c.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: c.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      max_output_tokens: 1400,
      reasoning: { effort: "low" },
      instructions: system,
      input: [{ role: "user", content: `Task: ${task}\nFacts/input:\n${encoded}` }],
    }),
  });
  if (!response.ok) {
    console.error("[ai]", task, response.status);
    return c.json({ code: "AI_PROVIDER_ERROR" }, 502);
  }
  const result = await response.json();
  const text = responseText(result);
  if (!text) return c.json({ code: "AI_EMPTY_RESPONSE" }, 502);
  await audit(c, { action: `ai.${task}`, entityType: body.ref_type ?? "ai_task",
    entityId: body.ref_id ?? null, after: { model: result.model, input_chars: encoded.length,
      output_chars: text.length } });
  return c.json({ text, model: result.model });
});

export default r;
