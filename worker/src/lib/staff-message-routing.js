const TOPIC_PATTERNS = {
  maintenance: /maintenance|repair|broken|leak|no heat|no hot water|not working|fix|維修|维修|壞了|坏了|漏水|沒有暖氣|没有暖气|沒有熱水|没有热水|不能用/i,
  complaint: /complaint|complain|noise|\bneighbours?\b|\bneighbors?\b|disturb|投訴|投诉|抱怨|噪音|鄰居|邻居/i,
  early_termination: /end (?:my |the )?lease early|break (?:my |the )?lease|early termination|move out early|提前退租|提前終止|提前终止|解除租約|解除租约/i,
  renewal: /renew(?:al)?|extend (?:my |the )?lease|續租|续租|延長租約|延长租约/i,
  showing_cancel: /cancel.{0,20}(?:showing|viewing|tour)|取消.{0,12}(?:看房|參觀|参观)/i,
  showing_reschedule: /reschedul|change.{0,20}(?:showing|viewing|tour)|改期|更改.{0,12}(?:看房|參觀|参观)/i,
  signing_booking: /book.{0,20}(?:signing|lease signing)|signing appointment|預約.{0,12}簽約|预约.{0,12}签约/i,
  showing_booking: /\bbook.{0,20}(?:showing|viewing|tour)|\bschedule.{0,20}(?:showing|viewing|tour)|預約看房|预约看房|安排看房|參觀房|参观房/i,
  showing_hours: /showing (?:hours|times|availability)|when can i (?:view|tour|see)|看房時間|看房时间|幾點可以看房|几点可以看房/i,
  waitlist_position: /waitlist.{0,24}(?:position|place|status|number)|where am i.{0,20}waitlist|候補.{0,12}(?:順位|位置|第幾|第几)|等候名單.{0,12}(?:順位|位置|第幾|第几)/i,
  parking_request: /(?:i (?:want|need|would like)|please|can i|could i).{0,24}(?:parking|stall|spot)|(?:register|request|add|apply).{0,20}(?:parking|stall|spot)|我想.{0,12}(?:登記|登记|申请|申請|要).{0,8}(?:車位|车位)|(?:車位|车位).{0,16}(?:我想)?(?:登記|登记|申请|申請)|(?:登記|登记|申请|申請).{0,8}(?:車位|车位)/i,
  parking_availability: /(?:parking|stall|spot).{0,28}(?:available|vacan|left|open|how many)|(?:available|vacan|how many).{0,28}(?:parking|stall|spot)|(?:車位|车位).{0,20}(?:有沒有|有没有|還有|还有|空位|剩)|(?:有沒有|有没有|還有|还有|剩).{0,20}(?:車位|车位)/i,
  pet_policy: /\bpets?\b|\bdogs?\b|\bcats?\b|pet policy|寵物|宠物|養狗|养狗|養貓|养猫|貓|猫|狗/i,
  amenities: /amenit(?:y|ies)|\bgym\b|lounge|games? room|pet wash|bike storage|facility|facilities|設施|设施|健身房|休息室|遊戲室|游戏室|洗寵物|洗宠物/i,
  location: /(?:where (?:is|are)|address|located|location|transit|\blrt\b)|地址|位置|(?:在|離|离).{0,12}(?:哪裡|哪里|地鐵|地铁|輕軌|轻轨|LRT)/i,
  unit_spec: /square feet|sq\.?\s*ft|bedroom|bathroom|balcony|floor plan|how (?:big|large)|面積|面积|平方(?:英尺|呎)|幾房|几房|臥室|卧室|浴室|陽台|阳台|戶型|户型/i,
  availability: /\bavailable\b|\bavailability\b|\bvacan(?:t|cy|cies)\b|empty (?:unit|suite)|any (?:unit|suite|apartment)|how many (?:units?|suites?|apartments?)|空房|空屋|可租|(?:還有|还有|有沒有|有没有|剩).{0,12}(?:房|套房|單位|单位|戶型|户型)|(?:房|套房|單位|单位|戶型|户型).{0,12}(?:還有|还有|有沒有|有没有|剩)/i,
  rent_quote: /monthly rent|rent (?:price|rate|amount|cost)|how much.{0,20}(?:unit|suite|apartment|rent)|(?:unit|suite|apartment).{0,20}(?:price|cost|rent)|房租|租金|月租|(?:房|套房|單位|单位|戶型|户型).{0,12}(?:多少錢|多少钱|價格|价格)/i,
  fees: /deposit|application fee|storage fee|utilities|additional fee|other fee|押金|保證金|保证金|申請費|申请费|儲物費|储物费|水電|水电|其他費用|其他费用/i,
};

const DATA_TOPICS = new Set([
  "availability", "rent_quote", "unit_spec", "amenities", "location",
  "pet_policy", "fees", "parking_availability", "waitlist_position",
]);

const PRIORITY = [
  "maintenance", "complaint", "early_termination", "renewal",
  "showing_cancel", "showing_reschedule", "signing_booking", "showing_booking",
  "showing_hours", "waitlist_position", "parking_request",
  "parking_availability", "pet_policy", "fees", "amenities", "location",
  "unit_spec", "availability", "rent_quote",
];

export function normalizeStaffMessage(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Routing is deliberately deterministic. The model drafts after this step; it
 * never decides whether a database lookup should happen.
 */
export function routeStaffMessage(value) {
  const text = normalizeStaffMessage(value);
  if (!text) return { intent: "other", topics: [], dataTopics: [], confidence: 0 };

  let topics = PRIORITY.filter((topic) => TOPIC_PATTERNS[topic].test(text));
  // "Parking available?" contains the generic word "available", but it is
  // not a suite-vacancy question. Keep the subject-specific route only.
  if (topics.some((topic) => ["parking_request", "parking_availability"].includes(topic)))
    topics = topics.filter((topic) => topic !== "availability");
  const intent = topics[0] ?? "other";
  const dataTopics = topics.filter((topic) => DATA_TOPICS.has(topic));
  return {
    intent,
    topics,
    dataTopics,
    confidence: topics.length ? 0.96 : 0.82,
  };
}

export function staffFactsForTopics(facts, topics) {
  const selected = {};
  const set = new Set(topics);

  if (["availability", "rent_quote", "unit_spec"].some((x) => set.has(x))) {
    selected.property = facts.property;
    selected.snapshot_at = facts.snapshot_at;
    selected.unit_types = facts.unit_types;
  }
  if (["parking_availability", "waitlist_position"].some((x) => set.has(x))) {
    selected.snapshot_at = facts.snapshot_at;
    selected.parking = facts.parking;
  }
  if (["pet_policy", "fees", "parking_availability"].some((x) => set.has(x))) {
    selected.fees = facts.fees;
  }
  if (set.has("amenities")) selected.amenities = [
    "Gym in every building", "Lounge and games room in every building",
    "Pet wash in every building", "Secure bicycle storage",
    "Outdoor patio", "Bus stop at the door",
  ];
  if (set.has("location")) selected.location =
    "370, 374 and 378 Clareview Station Drive NW, Edmonton, beside Clareview LRT";

  return selected;
}

export function numericFacts(value, found = new Set()) {
  if (typeof value === "number" && Number.isFinite(value)) found.add(Math.round(value));
  else if (Array.isArray(value)) value.forEach((item) => numericFacts(item, found));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) => numericFacts(item, found));
  return [...found];
}
