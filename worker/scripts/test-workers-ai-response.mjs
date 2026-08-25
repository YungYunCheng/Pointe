import assert from "node:assert/strict";
import {
  modelJson, PUBLIC_CHAT_RESPONSE_FORMAT, runWorkersAi, workersAiText,
} from "../src/lib/workers-ai.js";

const json = JSON.stringify({ answer:"Hello", needs_confirmation:false, topic:"summary" });

assert.equal(workersAiText({ response:json }), json);
assert.equal(workersAiText({ response:JSON.parse(json) }), json);
assert.equal(workersAiText({ result:{ response:json } }), json);
assert.equal(workersAiText({ result:{ response:JSON.parse(json) } }), json);
assert.equal(workersAiText({ choices:[{ message:{ content:json } }] }), json);
assert.equal(workersAiText({ result:{ choices:[{ message:{ content:json } }] } }), json);
assert.equal(workersAiText({ choices:[{ message:{ content:[{ type:"text", text:json }] } }] }), json);
assert.equal(workersAiText({ output_text:json }), json);
assert.equal(workersAiText({ choices:[{ text:json }] }), json);
assert.deepEqual(modelJson(`\`\`\`json\n${json}\n\`\`\``), {
  answer:"Hello", needs_confirmation:false, topic:"summary",
});
assert.deepEqual(PUBLIC_CHAT_RESPONSE_FORMAT.json_schema.required,
  ["answer", "needs_confirmation", "topic"]);

assert.deepEqual(await runWorkersAi({ run: async () => ({ response:json }) },
  "test-model", {}, 25), { response:json });
await assert.rejects(
  runWorkersAi({ run: () => new Promise(() => {}) }, "test-model", {}, 5),
  (error) => error.code === "AI_TIMEOUT",
);

console.log("Workers AI response tests passed (13 cases).");
