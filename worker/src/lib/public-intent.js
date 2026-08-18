const PATTERNS = {
  parking: /\bparking\b|\bpark(?:ing)?\s+(?:stall|spot|space)\b|\bstall\b|\bgarage\b|车位|車位|停车位|停車位|停车|停車|泊车|泊車/i,
  pets: /\bpets?\b|\bdogs?\b|\bcats?\b|\banimals?\b|寵物|宠物|養狗|养狗|養貓|养猫|貓|猫|狗/i,
  fees: /\bdeposit\b|\bstorage\b|application\s+fee|utilities?|security\s+deposit|押金|保證金|保证金|儲物|储物|水電|水电|申請費|申请费/i,
  amenities: /\bamenit(?:y|ies)\b|\bgym\b|\blounge\b|game\s+room|bike\s+storage|健身|休息室|遊戲室|游戏室|自行車|自行车/i,
  location: /\baddress\b|\blocation\b|\bwhere\b|\btransit\b|\blrt\b|地址|位置|在哪|交通|地鐵|地铁/i,
  availability: /\bavailable\b|\bavailability\b|\bvacan(?:t|cy|cies)\b|empty\s+(?:unit|suite)|how\s+many|do\s+you\s+have|any\s+(?:unit|suite|vacanc)|空房|空屋|幾套|几套|幾間|几间|還有|还有|剩下|剩多少|有沒有|有没有|有無|有无|有嗎|有吗|可租|出租|入住|move[ -]?in/i,
  rent: /\brent(?:al)?\b|monthly\s+(?:rent|rate)|suite\s+(?:rent|price)|unit\s+(?:rent|price)|房租|租金|月租|租(?:一間|一间|一套|房)/i,
  price: /how\s+much|what(?:'s|\s+is)\s+the\s+(?:price|cost)|\bprice\b|\bcost\b|\brate\b|多少錢|多少钱|價錢|价钱|價格|价格|幾錢|几钱|一個月多少|一个月多少/i,
  housing: /\bsuite\b|\bunit\b|\bapartment\b|\bbedroom\b|套房|房型|戶型|户型|公寓|房間|房间|房子|住房|一套/i,
};

const UNIT_TYPE = /(?:^|[^a-z0-9])(1a|1b|1c|2a|3a)(?:\s*\(m\)|\s*m)?(?:$|[^a-z0-9])/i;
const RENT_AND_PARKING = /(?:rent|房租|租金).{0,12}(?:and|plus|和|與|与|及|跟).{0,12}(?:parking|stall|车位|車位)|(?:parking|stall|车位|車位).{0,12}(?:and|plus|和|與|与|及|跟).{0,12}(?:rent|房租|租金)/i;

export function normalizePublicQuestion(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classifies only topics backed by the public Supabase snapshot. Price words
 * are treated as a qualifier, not as rent by themselves, so "车位多少钱"
 * cannot accidentally fall through to apartment rent.
 */
export function detectPublicIntents(value) {
  const text = normalizePublicQuestion(value);
  if (!text) return [];

  const parking = PATTERNS.parking.test(text);
  const pets = PATTERNS.pets.test(text);
  const fees = PATTERNS.fees.test(text);
  const amenities = PATTERNS.amenities.test(text);
  const location = PATTERNS.location.test(text);
  const availability = PATTERNS.availability.test(text);
  const rent = PATTERNS.rent.test(text);
  const price = PATTERNS.price.test(text);
  const housing = PATTERNS.housing.test(text) || UNIT_TYPE.test(text);

  // A named subject always wins over the generic words "price" and "rent".
  // Explicitly asking for both apartment rent and parking is still supported.
  if (parking) return RENT_AND_PARKING.test(text) ? ["parking", "rent"] : ["parking"];
  if (pets) return ["pets"];
  if (fees) return ["fees"];
  if (amenities) return ["amenities"];
  if (location) return ["location"];

  const intents = [];
  if (availability) intents.push("availability");
  if (rent || (price && housing)) intents.push("rent");
  if (intents.length) return [...new Set(intents)];

  // A price without an object is unsafe to guess. The caller asks a short
  // follow-up instead of returning every apartment rent.
  if (price) return ["clarification"];
  return [];
}
