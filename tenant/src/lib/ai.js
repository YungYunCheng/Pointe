/* ============================================================
   AI shim

   Every model call goes to the server. Called from the browser the
   API key ends up in the bundle, and the call leaves nothing in the
   audit trail — neither is acceptable once real tenant messages are
   going through it.

   The task name selects a prompt held on the server. A caller
   supplies facts, not instructions.

   Falls back to the direct call only when no server is answering, so
   a tool opened in a sandbox still demonstrates. That path is never
   used in the container, where /api is proxied by nginx.
   ============================================================ */

/** The public chat has no session. Rate limited by address on the server,
 *  because the alternative is either an account wall in front of "how much is
 *  rent" or an open budget. */
export async function publicAi(input) {
  const res = await fetch("/api/public/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.code || `AI_${res.status}`);
  }
  return res.json();
}

export async function publicHandoff(input) {
  const res = await fetch("/api/public/chat/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.code || `HANDOFF_${res.status}`);
  }
  return res.json();
}

export async function ai(task, input, ref = {}) {
  const res = await fetch(`/api/ai/${task}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ input, ...ref }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.code || `AI_${res.status}`);
  }
  return (await res.json()).text;
}

/** JSON-shaped tasks. The model is asked for JSON; this strips a code fence
 *  if one comes back anyway rather than failing on it. */
export async function aiJson(task, input, ref = {}) {
  const text = await ai(task, input, ref);
  return JSON.parse(String(text).replace(/```json|```/g, "").trim());
}
