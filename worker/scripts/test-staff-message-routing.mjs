import assert from "node:assert/strict";
import { routeStaffMessage } from "../src/lib/staff-message-routing.js";

const cases = [
  ["你还有什么想告诉我的？", "other", []],
  ["有没有更好的办法？", "other", []],
  ["Where can I learn more about the neighbourhood?", "other", []],
  ["请问现在还有 1A 户型吗？", "unit_spec", ["unit_spec", "availability"]],
  ["What is the monthly rent for a 2A suite?", "rent_quote", ["rent_quote"]],
  ["Do you have underground parking available?", "parking_availability", ["parking_availability"]],
  ["370-412 还有没有车位，我想登记", "parking_request", ["parking_request", "parking_availability"]],
  ["厨房水龙头漏水了，可以帮我维修吗？", "maintenance", ["maintenance"]],
  ["Can I reschedule my viewing?", "showing_reschedule", ["showing_reschedule"]],
  ["健身房和休息室有哪些设施？", "amenities", ["amenities"]],
  ["Baydo Pointe 在哪里？", "location", ["location"]],
];

for (const [message, intent, topics] of cases) {
  const routed = routeStaffMessage(message);
  assert.equal(routed.intent, intent, message);
  assert.deepEqual(routed.topics, topics, message);
}

console.log(`Staff message routing tests passed (${cases.length} cases).`);
