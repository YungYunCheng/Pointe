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
};

r.post("/ai/:task", async (c) => {
  const task = c.req.param("task");
  const body = await c.req.json().catch(() => ({}));
  const input = body.input ?? {};
  const encoded = JSON.stringify(input);
  if (encoded.length > 80_000) return c.json({ code: "AI_INPUT_TOO_LARGE" }, 413);
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ code: "AI_NOT_CONFIGURED" }, 503);

  const system = PROMPTS[task] ??
    `Assist a property-management employee with the named task. Use only supplied facts, do not take actions, move money, make legal decisions, or promise an outcome. Return a draft for human review.`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": c.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: c.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest",
      max_tokens: 1400,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: `Task: ${task}\nFacts/input:\n${encoded}` }],
    }),
  });
  if (!response.ok) {
    console.error("[ai]", task, response.status);
    return c.json({ code: "AI_PROVIDER_ERROR" }, 502);
  }
  const result = await response.json();
  const text = (result.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  await audit(c, { action: `ai.${task}`, entityType: body.ref_type ?? "ai_task",
    entityId: body.ref_id ?? null, after: { model: result.model, input_chars: encoded.length,
      output_chars: text.length } });
  return c.json({ text, model: result.model });
});

export default r;
