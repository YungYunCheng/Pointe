const PATTERNS = {
  parking: /\bparking\b|\bpark(?:ing)?\s+(?:stall|spot|space)\b|\bstall\b|\bgarage\b|车位|車位|停车位|停車位|停车|停車|泊车|泊車/i,
  pets: /\bpets?\b|\bdogs?\b|\bcats?\b|\banimals?\b|寵物|宠物|養狗|养狗|養貓|养猫|貓|猫|狗/i,
  fees: /\bdeposit\b|\bstorage\b|application\s+fee|utilities?|security\s+deposit|押金|保證金|保证金|儲物|储物|水電|水电|申請費|申请费/i,
  amenities: /\bamenit(?:y|ies)\b|\bgym\b|\blounge\b|game\s+room|bike\s+storage|健身|休息室|遊戲室|游戏室|自行車|自行车/i,
  location: /\baddress\b|\blocation\b|\btransit\b|\blrt\b|where\s+(?:is|are).{0,24}(?:building|property|baydo|pointe)|(?:building|property|baydo|pointe).{0,24}where|地址|位置|交通|地鐵|地铁|(?:大樓|大楼|公寓|Baydo|Pointe).{0,12}(?:在哪|哪裡|哪里)|(?:在哪|哪裡|哪里).{0,12}(?:大樓|大楼|公寓|Baydo|Pointe)/i,
  availability: /\bavailable\b|\bavailability\b|\bvacan(?:t|cy|cies)\b|empty\s+(?:unit|suite)|how\s+many\s+(?:units?|suites?|apartments?)|any\s+(?:unit|suite|vacanc)|空房|空屋|幾套|几套|幾間|几间|剩多少(?:房|套|間|间)?|可租(?:的)?(?:房|單位|单位|套房)|出租(?:的)?(?:房|單位|单位|套房)/i,
  rent: /monthly\s+(?:rent|rate)|(?:suite|unit|apartment)\s+(?:rent|price)|rent\s+(?:price|rate|cost)|how\s+much\s+is\s+(?:the\s+)?rent|房租|租金|月租|租(?:一間|一间|一套|房).{0,12}(?:多少|價格|价格)/i,
  price: /how\s+much|what(?:'s|\s+is)\s+the\s+(?:price|cost)|\bprice\b|\bcost\b|\brate\b|多少錢|多少钱|價錢|价钱|價格|价格|幾錢|几钱|一個月多少|一个月多少/i,
  housing: /\bsuite\b|\bunit\b|\bapartment\b|\bbedroom\b|套房|房型|戶型|户型|公寓|房間|房间|房子|住房|一套|一房|两房|兩房|二房|[12]\s*房|一居|两居|兩居|二居/i,
};

const UNIT_TYPE = /(?:^|[^a-z0-9])(1a|1b|1c|2a|3a)(?:\s*\(m\)|\s*m)?(?:$|[^a-z0-9])/i;
const RENT_AND_PARKING = /(?:rent|房租|租金).{0,12}(?:and|plus|和|與|与|及|跟).{0,12}(?:parking|stall|车位|車位)|(?:parking|stall|车位|車位).{0,12}(?:and|plus|和|與|与|及|跟).{0,12}(?:rent|房租|租金)/i;
const GENERIC_AVAILABILITY = /do\s+you\s+have|(?:還有|还有|有沒有|有没有|有無|有无|有嗎|有吗|剩下)|move[ -]?in|入住/i;

export function normalizePublicQuestion(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Visitors normally ask for a one- or two-bedroom home, not an internal
 * floor-plan code. Keep the public language separate from 1A/2A routing. */
export function bedroomCountFromPublicQuestion(value) {
  const text = normalizePublicQuestion(value);
  if (/\b(?:two|2)[ -]?bed(?:room)?s?\b|(?:兩|两|二|2)\s*(?:房|居|室)/i.test(text)) return 2;
  if (/\b(?:one|1)[ -]?bed(?:room)?s?\b|(?:一|1)\s*(?:房|居|室)/i.test(text)) return 1;
  return null;
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
  const housing = PATTERNS.housing.test(text) || UNIT_TYPE.test(text);
  const availability = PATTERNS.availability.test(text)
    || (GENERIC_AVAILABILITY.test(text) && housing);
  const rent = PATTERNS.rent.test(text);
  const price = PATTERNS.price.test(text);

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
