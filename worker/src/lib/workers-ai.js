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
  if (typeof result?.result?.response === "string") return result.result.response.trim();
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
