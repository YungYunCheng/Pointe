import assert from "node:assert/strict";
import { detectPublicIntents } from "../src/lib/public-intent.js";

const cases = [
  ["有车位么？多少钱", ["parking"]],
  ["我是问车位多少钱", ["parking"]],
  ["地下停车位一个月多少钱", ["parking"]],
  ["How much is parking?", ["parking"]],
  ["3A 租金多少钱", ["rent"]],
  ["3A 还有几套，多少钱", ["availability", "rent"]],
  ["现在3A还有几套", ["availability"]],
  ["有没有 1A？", ["availability"]],
  ["Do you have any 2A units?", ["availability"]],
  ["租一套一个月多少", ["rent"]],
  ["宠物租金多少", ["pets"]],
  ["storage多少钱", ["fees"]],
  ["房租和车位多少钱", ["parking", "rent"]],
  ["多少钱", ["clarification"]],
  ["Where is the building?", ["location"]],
  ["Where can I read more about this?", []],
  ["你还有什么想告诉我的？", []],
  ["有没有更好的办法？", []],
  ["I want to rent here. What should I know?", []],
  ["什么时候可以入住 1A？", ["availability"]],
];

for (const [question, expected] of cases) {
  assert.deepEqual(detectPublicIntents(question), expected, question);
}

console.log(`Public intent tests passed (${cases.length} cases).`);
