function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "")
    .join("").trim();
}

/** Cloudflare models may return the legacy response field or the newer
 * Chat Completions choices shape. Keep both so changing a model does not
 * silently turn a valid answer into a staff handoff. */
export function workersAiText(result) {
  if (typeof result === "string") return result.trim();
  if (typeof result?.response === "string") return result.response.trim();
  if (result?.response && typeof result.response === "object")
    return JSON.stringify(result.response);
  if (typeof result?.result?.response === "string") return result.result.response.trim();
  if (result?.result?.response && typeof result.result.response === "object")
    return JSON.stringify(result.result.response);
  if (typeof result?.output_text === "string") return result.output_text.trim();
  if (typeof result?.result?.output_text === "string") return result.result.output_text.trim();
  const directChoice = contentText(result?.choices?.[0]?.message?.content);
  if (directChoice) return directChoice;
  if (typeof result?.choices?.[0]?.text === "string") return result.choices[0].text.trim();
  return contentText(result?.result?.choices?.[0]?.message?.content);
}

export function modelJson(text) {
  const clean = String(text ?? "").replace(/```(?:json)?|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return null; }
}

export const PUBLIC_CHAT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      needs_confirmation: { type: "boolean" },
      topic: { type: "string" },
    },
    required: ["answer", "needs_confirmation", "topic"],
  },
};

export const AI_TIMEOUT_MS = 15_000;

/** Keep a slow or capacity-constrained model from holding the browser open
 * indefinitely. The caller still decides whether to hand the request to a
 * person or return an error, but every AI path now has a bounded wait. */
export async function runWorkersAi(ai, model, input, timeoutMs = AI_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      ai.run(model, input),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Workers AI did not respond within ${timeoutMs} ms`);
          error.code = "AI_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
