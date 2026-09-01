import { Hono } from "hono";
import { audit } from "../lib/auth.js";
import { bedroomCountFromPublicQuestion, detectPublicIntents }
  from "../lib/public-intent.js";
import { numericFacts, routeStaffMessage, staffFactsForTopics }
  from "../lib/staff-message-routing.js";
import { runWorkersAi, workersAiText } from "../lib/workers-ai.js";

const r = new Hono();

const PROMPTS = {
  inbox_draft: `Draft a concise property-management reply after the application has already routed the message. Do not reclassify it and do not decide whether to query a database. Use a supplied property fact only when it directly answers the customer's question. If no property facts are supplied, do not introduce rents, vacancies, units, parking or fees. Reply in the customer's language. Never invent prices, availability, policy, legal conclusions or promises. Return only the reply text, with no JSON or Markdown.`,
  intake_question: `Help collect lease-intake fields. Extract only clearly stated values. Ask one neutral question at a time and do not ask about protected personal characteristics. Output JSON only: {"extracted":{},"next_question":"question or null","done":false}.`,
  template_fields: `Identify fillable fields explicitly present in the supplied approved document text. Output a JSON array only. Each item must have key, label, source_text and confidence. Do not add clauses or legal language.`,
  document_convert: `Reformat the supplied document content for the requested operational target without changing its meaning, amounts, clauses, or obligations. Return only the converted content.`,
  entry_notice: `Draft a clear bilingual English and Traditional Chinese notice of entry using only the supplied unit, date, time window and purpose. Do not add legal claims or change the time. Return notice text only for staff review.`,
  purchase_order: `Draft a purchase-order description, scope and expense lines from the maintenance facts. Output JSON only with description, scope, gl_code, lines and needs_quote. Amounts must be blank unless a vendor quote is supplied.`,
  parking_advice: `Analyse the supplied parking allocation facts. Explain operational risks and practical next checks without inventing availability or policy. Return concise staff guidance.`,
  report_narrative: `Turn the supplied accounting figures into a concise factual management narrative. Do not change or infer figures. Flag missing comparisons.`,
  public_chat: `Answer a prospective tenant using only the supplied public property data and approved company rules. Reply in the visitor's language. First answer the visitor's actual question; do not turn a greeting, conversational question or unrelated question into a rent, vacancy or database lookup. Use a property fact only when it is directly relevant. Never invent or guarantee availability, rent, fees, parking, dates, policies, approval, a reservation or an outcome. Counts are a current snapshot and may change. If the answer is not present, say the leasing team must confirm it. Do not reveal unit numbers, tenant information, leases, payments, vehicle information or internal notes. Keep the answer concise and do not output JSON.`,
};

const adminOnly = async (c, next) => {
  if (c.get("user")?.role !== "admin") return c.json({ code: "FORBIDDEN" }, 403);
  return next();
};

const clipped = (value, max = 4000) => String(value ?? "").slice(0, max);

const STAFF_FACT_LABELS = {
  availability: "Live suite availability", rent_quote: "Current rent range",
  unit_spec: "Unit type and size", amenities: "Approved amenities",
  location: "Approved address and transit", pet_policy: "Current pet fees and limits",
  fees: "Current fee settings", parking_availability: "Live parking availability",
  waitlist_position: "Current aggregate parking waitlist",
};

function staffMissingInfo(route) {
  if (route.intent === "waitlist_position")
    return "An individual's waitlist position requires staff confirmation.";
  if (["showing_hours", "showing_booking", "showing_reschedule", "showing_cancel",
    "signing_booking"].includes(route.intent))
    return "The scheduling system must confirm the requested time.";
  if (route.intent === "parking_request")
    return "A parking assignment requires staff confirmation.";
  return null;
}

function staffFallbackDraft(message, route) {
  const zh = /[\u3400-\u9fff]/.test(message);
  if (route.intent === "maintenance") return zh
    ? "已收到你的維修問題。我們會交由大樓管理同事查看並回覆你；若情況緊急，請直接致電辦公室。"
    : "We received your maintenance request. Building staff will review it and reply; if it is urgent, please call the office.";
  return zh
    ? "已收到你的問題。這項內容需要同事確認，我們會盡快回覆你。"
    : "We received your question. A team member needs to confirm this and will reply as soon as possible.";
}

function staffDraftResult({ route, draft, selectedFacts, missingInfo, fallback = false }) {
  return JSON.stringify({
    intent: route.intent,
    topics: route.topics,
    confidence: route.confidence,
    draft: clipped(draft, 5000),
    facts_used: route.dataTopics.map((topic) => STAFF_FACT_LABELS[topic]).filter(Boolean),
    allowed_numbers: numericFacts(selectedFacts),
    missing_info: missingInfo,
    needs_review: fallback || route.intent === "other" || !!missingInfo,
  });
}

async function trainingContext(c, task) {
  try {
    const rules = await c.get("db")`
      SELECT title, instruction, task
      FROM ai_training_rules
      WHERE is_active = TRUE AND (task IS NULL OR task = ${task})
      ORDER BY CASE WHEN task = ${task} THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 20`;
    const examples = await c.get("db")`
      SELECT original_input, approved_output
      FROM ai_feedback_examples
      WHERE review_status = 'approved' AND task = ${task}
      ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
      LIMIT 4`;
    const sections = [];
    if (rules.length) sections.push("Company rules:\n" + rules
      .map((x) => `- ${clipped(x.title, 120)}: ${clipped(x.instruction, 1200)}`).join("\n"));
    if (examples.length) sections.push("Approved examples (follow the approach, not private facts):\n" + examples
      .map((x, i) => `Example ${i + 1}\nInput: ${clipped(x.original_input)}\nApproved output: ${clipped(x.approved_output)}`)
      .join("\n\n"));
    return sections.join("\n\n");
  } catch (error) {
    // Migration 018 may not have been applied yet. AI stays available with
    // its base prompt instead of turning a pending admin setup into downtime.
    console.warn("[ai-training-context]", error?.message ?? error);
    return "";
  }
}

/** A deliberately narrow, public snapshot. The model never receives rows
 * containing tenants, leases, payments, vehicles, unit numbers or notes. */
async function publicPropertyFacts(sql) {
  const types = await sql`
    SELECT replace(u.unit_type_code, ' (M)', '') AS code,
      MIN(t.bedroom_label_en) AS label_en,
      MIN(t.bedroom_label_zh) AS label_zh,
      MIN(t.area_sqft) AS area_sqft,
      COUNT(*) FILTER (WHERE u.status = 'available')::int AS available,
      MIN(u.available_from) FILTER (WHERE u.status = 'available') AS earliest,
      COALESCE(MIN(COALESCE(u.rent_override, r.base_rent))
        FILTER (WHERE u.status = 'available'), MIN(r.base_rent)) AS rent_from,
      COALESCE(MAX(COALESCE(u.rent_override, r.base_rent))
        FILTER (WHERE u.status = 'available'), MAX(r.base_rent)) AS rent_to
    FROM units u
    JOIN unit_types t ON t.code = u.unit_type_code
    LEFT JOIN LATERAL (
      SELECT id FROM pricing_profiles
      WHERE effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC LIMIT 1
    ) p ON TRUE
    LEFT JOIN unit_type_rents r
      ON r.pricing_profile_id = p.id AND r.unit_type_code = u.unit_type_code
    GROUP BY replace(u.unit_type_code, ' (M)', '')
    ORDER BY MIN(t.area_sqft)`;

  const parking = await sql`
    SELECT p.code, p.label_en, p.label_zh, p.is_surface,
      p.total_stalls,
      COUNT(a.id) FILTER (WHERE a.status = 'assigned')::int AS assigned,
      GREATEST(p.total_stalls -
        COUNT(a.id) FILTER (WHERE a.status = 'assigned')::int, 0) AS available,
      COUNT(a.id) FILTER (WHERE a.status = 'waiting')::int AS waiting
    FROM parking_pools p
    LEFT JOIN parking_allocations a ON a.pool_code = p.code
    GROUP BY p.code, p.label_en, p.label_zh, p.is_surface, p.total_stalls
    ORDER BY p.is_surface, p.code`;

  const [fees] = await sql`
    SELECT f.deposit_mode, f.deposit_fixed, f.cat_deposit, f.dog_deposit,
      f.pet_rent, f.pet_limit, f.parking_underground, f.parking_surface,
      f.storage_fee, f.application_fee, f.utilities_included
    FROM fee_settings f
    JOIN pricing_profiles p ON p.id = f.pricing_profile_id
    WHERE p.effective_from <= CURRENT_DATE
      AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    ORDER BY p.effective_from DESC LIMIT 1`;

  const [site] = await sql`
    SELECT content FROM public_site_settings WHERE id = 'main'`;
  let siteContent = site?.content ?? {};
  if (typeof siteContent === "string") {
    try { siteContent = JSON.parse(siteContent); } catch { siteContent = {}; }
  }
  const publishedContact = siteContent?.contact ?? {};

  return {
    property: "Baydo Pointe, Clareview, Edmonton",
    snapshot_at: new Date().toISOString(),
    unit_types: types,
    parking,
    fees: fees ?? null,
    contact: {
      name: clipped(publishedContact.name, 120).trim()
        || "Baydo Pointe Leasing Team",
      phone: clipped(publishedContact.phone, 80).trim() || "780-937-8677",
      email: clipped(publishedContact.email, 160).trim()
        || "rentals@themizar.ca",
    },
  };
}

const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function workersAiModel(c) {
  return c.env.WORKERS_AI_MODEL ?? DEFAULT_WORKERS_AI_MODEL;
}

async function recordAiRun(sql, data) {
  try {
    const id = `airun_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const provider = data.provider ?? "database";
    const model = data.model ?? "";
    const question = clipped(data.question, 4000);
    const answer = clipped(data.answer, 8000);
    await sql.begin(async (tx) => {
      await tx`INSERT INTO ai_chat_runs (id, source, conversation_key, question,
        answer, language, provider, model, used_ai, needs_human, escalation_id,
        error_code, input_chars, output_chars, metadata)
        VALUES (${id}, ${data.source ?? "public_chat"}, ${data.conversationKey ?? null},
          ${question}, ${answer || null}, ${data.language ?? "en"}, ${provider},
          ${model}, ${provider === "workers_ai"}, ${!!data.needsHuman},
          ${data.escalationId ?? null}, ${data.errorCode ?? null}, ${question.length},
          ${answer.length}, ${JSON.stringify(data.metadata ?? {})})`;
      await tx`INSERT INTO ai_usage_daily (usage_date, provider, model, request_count,
        error_count, input_chars, output_chars, updated_at)
        VALUES (CURRENT_DATE, ${provider}, ${model}, 1, ${data.errorCode ? 1 : 0},
          ${question.length}, ${answer.length}, now())
        ON CONFLICT (usage_date, provider, model) DO UPDATE SET
          request_count = ai_usage_daily.request_count + 1,
          error_count = ai_usage_daily.error_count + EXCLUDED.error_count,
          input_chars = ai_usage_daily.input_chars + EXCLUDED.input_chars,
          output_chars = ai_usage_daily.output_chars + EXCLUDED.output_chars,
          updated_at = now()`;
    });
    return id;
  } catch (error) {
    // Migration 019 can be applied after the Worker is deployed. Missing
    // telemetry must never make rent or vacancy answers unavailable.
    console.warn("[ai-run-record]", error?.message ?? error);
    return null;
  }
}

const HUMAN_ONLY_PUBLIC = [
  { topic: "application_or_eligibility", ruleId: "R-101",
    re: /application status|approve|approval|eligible|eligibility|qualif|income|credit|background|申请资格|申請資格|审批|審批|收入|信用|背景/i },
  { topic: "accessibility_or_accommodation", ruleId: "R-102",
    re: /disab|accessib|accommodat|wheelchair|medical|残疾|殘疾|无障碍|無障礙|便利安排|醫療|医疗/i },
  { topic: "legal_or_complaint", ruleId: "R-103",
    re: /legal|lawyer|human rights|discrimin|complaint|evict|法律|律师|律師|人权|人權|歧视|歧視|投诉|投訴|驱逐|驅逐/i },
  { topic: "account_or_private_record", ruleId: "R-104",
    re: /my lease|my payment|my account|tenant name|unit number|我的租约|我的租約|我的付款|我的帳號|我的账号|租客姓名|房号|房號/i },
];

const money = (value) => value == null || value === "" || !Number.isFinite(Number(value))
  ? null : `$${Math.round(Number(value)).toLocaleString("en-CA")}`;
const dateText = (value, zh) => {
  if (!value) return null;
  const direct = value instanceof Date ? value : new Date(value);
  const parsed = Number.isFinite(direct.getTime()) ? direct
    : new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleDateString(zh ? "zh-TW" : "en-CA",
    { year:"numeric", month:"long", day:"numeric", timeZone:"UTC" });
};
const unitTypeFrom = (message) => {
  const m = String(message).toUpperCase().match(/(?:^|\s|[^A-Z0-9])(1A|1B|1C|2A|3A)(?:\s*\(M\)|\s*M)?(?:$|\s|[^A-Z0-9])/);
  return m?.[1] ?? null;
};

const bedroomCountForUnit = (unit) => {
  const labelled = String(unit?.label_en ?? "").match(/\b([12])\b/);
  if (labelled) return Number(labelled[1]);
  return ["1A", "1B", "1C"].includes(unit?.code) ? 1
    : ["2A", "3A"].includes(unit?.code) ? 2 : null;
};

function publicBedroomAnswer(message, facts, zh, intents) {
  const bedrooms = bedroomCountFromPublicQuestion(message);
  if (!bedrooms) return null;
  const rows = facts.unit_types.filter((unit) => bedroomCountForUnit(unit) === bedrooms);
  if (!rows.length) return null;

  const availableRows = rows.filter((unit) => Number(unit.available) > 0);
  const available = availableRows.reduce((sum, unit) => sum + Number(unit.available), 0);
  const rents = rows.flatMap((unit) => [unit.rent_from, unit.rent_to])
    .map(Number).filter(Number.isFinite);
  const areas = [...new Set(rows.map((unit) => Math.round(Number(unit.area_sqft)))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  const dates = availableRows.map((unit) => unit.earliest).filter(Boolean)
    .map((value) => ({ value, time:new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.time)).sort((a, b) => a.time - b.time);
  const earliest = dates.length ? dateText(dates[0].value, zh) : null;
  const hasDen = rows.some((unit) => /den|書房|书房/i.test(
    `${unit.label_en ?? ""} ${unit.label_zh ?? ""}`));
  const kind = zh ? `${bedrooms === 1 ? "一" : "兩"}房` : `${bedrooms}-bedroom`;
  const parts = [];

  if (intents.includes("availability")) parts.push(zh
    ? (available
      ? `目前${kind}戶型共有 ${available} 套可租${earliest ? `，最早可於 ${earliest} 入住` : ""}`
      : `目前沒有${kind}空房`)
    : (available
      ? `There are currently ${available} ${kind} suites available${earliest ? `, with the earliest move-in on ${earliest}` : ""}`
      : `There are no ${kind} suites currently available`));
  if (intents.includes("rent") && rents.length) {
    const low = money(Math.min(...rents)), high = money(Math.max(...rents));
    parts.push(zh ? `${kind}月租約 ${low}${high !== low ? `–${high}` : ""}`
      : `${kind} rent is currently ${low}${high !== low ? `–${high}` : ""} per month`);
  }
  if (areas.length) parts.push(zh
    ? `可選面積約 ${areas.join("、")} 平方英尺${hasDen ? "，部分格局帶書房" : ""}`
    : `Available layouts are approximately ${areas.join(", ")} sq. ft.${hasDen ? ", including layouts with a den" : ""}`);

  return { intent:intents.join("+"), text:`${parts.join(zh ? "；" : ". ")}${zh ? "。" : ". "}${
    zh ? "空房與價格為目前資料，可能隨時變動。" : "Availability and pricing are a current snapshot and may change."}` };
}

function publicAnswerForIntent(message, facts, zh, intent) {
  const type = unitTypeFrom(message);
  const unit = type ? facts.unit_types.find((x) => x.code === type) : null;
  const snapshot = zh ? "空房與車位為目前資料，可能隨時變動。" : "Availability is a current snapshot and may change.";

  if (intent === "contact") {
    const contact = facts.contact ?? {};
    const name = contact.name || "Baydo Pointe Leasing Team";
    const phone = contact.phone || "780-937-8677";
    const email = contact.email || "rentals@themizar.ca";
    return { intent, text: zh
      ? `你可以聯絡 Baydo Pointe 租賃團隊：\n聯絡人：${name}\n電話：${phone}\nEmail：${email}`
      : `You can contact the Baydo Pointe leasing team:\nContact: ${name}\nPhone: ${phone}\nEmail: ${email}` };
  }

  if (intent === "parking") {
    if (!facts.parking?.length) return null;
    const rows = facts.parking.map((p) => `${zh ? p.label_zh : p.label_en}: ${p.available}`);
    const underground = money(facts.fees?.parking_underground);
    const surface = money(facts.fees?.parking_surface);
    const prices = [underground && (zh ? `地下車位每月 ${underground}` : `underground ${underground}/month`),
      surface && (zh ? `地面車位每月 ${surface}` : `surface ${surface}/month`)].filter(Boolean).join(zh ? "；" : "; ");
    return { intent, text: zh
      ? `目前車位資料：${rows.join("；")}。${prices ? `${prices}。` : ""}${snapshot}最後分配需由同事確認。`
      : `Current parking availability: ${rows.join("; ")}.${prices ? ` ${prices}.` : ""} ${snapshot} Final allocation must be confirmed by staff.` };
  }

  if (intent === "pets") {
    const f = facts.fees;
    if (!f) return null;
    const parts = [money(f.cat_deposit) && (zh ? `貓押金 ${money(f.cat_deposit)}` : `cat deposit ${money(f.cat_deposit)}`),
      money(f.dog_deposit) && (zh ? `狗押金 ${money(f.dog_deposit)}` : `dog deposit ${money(f.dog_deposit)}`),
      money(f.pet_rent) && (zh ? `寵物月租 ${money(f.pet_rent)}` : `pet rent ${money(f.pet_rent)}/month`),
      f.pet_limit && (zh ? `限制：${f.pet_limit}` : `limit: ${f.pet_limit}`)].filter(Boolean);
    if (!parts.length) return null;
    return { intent, text: zh ? `目前寵物資料：${parts.join("；")}。申请前请由租赁同事确认。`
      : `Current pet information: ${parts.join("; ")}. Please have the leasing team confirm before applying.` };
  }

  if (intent === "rent") {
    const rows = type ? (unit ? [unit] : []) : facts.unit_types.filter((x) => x.rent_from != null);
    if (!rows.length) return null;
    const prices = rows.map((x) => {
      const lo = money(x.rent_from), hi = money(x.rent_to);
      return `${x.code}: ${lo}${hi && hi !== lo ? `–${hi}` : ""}`;
    });
    return { intent, text: zh ? `目前月租：${prices.join("；")}。停车、储物及宠物费用另计，最终价格以申请时确认为准。`
      : `Current monthly rent: ${prices.join("; ")}. Parking, storage and pet charges are separate; final pricing is confirmed at application.` };
  }

  if (intent === "availability") {
    const rows = type ? (unit ? [unit] : []) : facts.unit_types.filter((x) => Number(x.available) > 0);
    if (!rows.length) return { intent, text: zh ? `目前沒有找到${type ? ` ${type}` : ""}可出租单位。${snapshot}`
      : `I do not currently see an available${type ? ` ${type}` : ""} suite. ${snapshot}` };
    const found = rows.map((x) => {
      const date = dateText(x.earliest, zh);
      return zh ? `${x.code}：${x.available} 套${date ? `，最早 ${date}` : ""}`
        : `${x.code}: ${x.available}${date ? `, earliest ${date}` : ""}`;
    });
    return { intent, text: zh ? `目前空房：${found.join("；")}。${snapshot}`
      : `Currently available: ${found.join("; ")}. ${snapshot}` };
  }

  if (intent === "fees") {
    const f = facts.fees;
    if (!f) return null;
    const parts = [money(f.deposit_fixed) && (zh ? `保证金 ${money(f.deposit_fixed)}` : `deposit ${money(f.deposit_fixed)}`),
      money(f.storage_fee) && (zh ? `储物柜每月 ${money(f.storage_fee)}` : `storage ${money(f.storage_fee)}/month`),
      money(f.application_fee) && (zh ? `申请费 ${money(f.application_fee)}` : `application fee ${money(f.application_fee)}`),
      f.utilities_included && (zh ? `租金包含：${f.utilities_included}` : `included in rent: ${f.utilities_included}`)].filter(Boolean);
    if (!parts.length) return null;
    return { intent, text: zh ? `目前费用资料：${parts.join("；")}。` : `Current fee information: ${parts.join("; ")}.` };
  }

  if (intent === "amenities") return { intent, text: zh
    ? "Baydo Pointe 每栋设有健身房、休息室、游戏室、宠物清洗区和自行车储存空间。"
    : "Each Baydo Pointe building has a gym, lounge, games room, pet wash and bicycle storage." };
  if (intent === "location") return { intent, text: zh
    ? "Baydo Pointe 位于 370、374、378 Clareview Station Drive NW, Edmonton，邻近 Clareview LRT。"
    : "Baydo Pointe is at 370, 374 and 378 Clareview Station Drive NW, Edmonton, beside Clareview LRT." };
  return null;
}

function publicAnswer(message, facts, zh) {
  const intents = detectPublicIntents(message);
  if (intents[0] === "clarification") return {
    intent: "clarification",
    text: zh
      ? "你想問的是房租、車位價格、空房數量，還是其他費用？請告訴我項目，我會查目前資料。"
      : "Are you asking about suite rent, parking price, available suites, or another fee? Tell me the item and I will check the current data.",
  };
  if (intents.some((intent) => ["availability", "rent"].includes(intent))) {
    const bedroomAnswer = publicBedroomAnswer(message, facts, zh, intents);
    if (bedroomAnswer) return bedroomAnswer;
  }
  const answers = intents.map((intent) => publicAnswerForIntent(message, facts, zh, intent)).filter(Boolean);
  if (!answers.length) return null;
  return {
    intent: answers.map((answer) => answer.intent).join("+"),
    text: answers.map((answer) => answer.text).join(zh ? "\n" : "\n"),
  };
}

function assignedRole(message, topic = "") {
  const text = `${topic} ${message}`;
  if (/maintenance|emergency|repair|漏水|暖氣|暖气|熱水|热水|維修|维修/i.test(text)) return "building_manager";
  if (/payment|charge|receipt|accounting|付款|收費|收费|帳單|账单|收據|收据/i.test(text)) return "accounting";
  return "property_manager";
}

async function queuePublicConfirmation(sql, { message, language, topic, ruleId, threadId }) {
  const role = assignedRole(message, topic);
  const sensitive = ["R-101", "R-102", "R-103"].includes(ruleId);
  const [person] = await sql`SELECT id, email, full_name FROM users
    WHERE role_code = ${role} AND is_active = TRUE ORDER BY created_at LIMIT 1`;
  const id = `esc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const outboxId = person ? `ob_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` : null;
  const notificationId = `nt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const due = new Date(Date.now() + 24 * 3600e3).toISOString();
  const link = "/confirmations";
  await sql.begin(async (tx) => {
    // The escalation references the queued notification, so the outbox row
    // must exist first for the foreign-key check to succeed.
    if (person) await tx`INSERT INTO outbox (id, channel, to_email, to_name, kind,
      subject, body, ref_type, ref_id, required_by)
      VALUES (${outboxId}, 'email', ${person.email}, ${person.full_name}, 'escalation',
        ${`Customer chat needs confirmation · ${topic || 'unrecognised'}`},
        ${sensitive
          ? `A sensitive customer question needs a person. Rule: ${ruleId}. The message content is not copied into email.\n\nAssigned role: ${role}\nExpected response by: ${due}`
          : `A customer question needs confirmation:\n\n${message}\n\nAssigned role: ${role}\nExpected response by: ${due}`},
        'escalation', ${id}, ${new Date(Date.now() + 10 * 60000).toISOString()})`;
    await tx`INSERT INTO escalations (id, message_id, source, rule_id, topic, locale,
      body_included, body, assigned_role, assigned_to, outbox_id, state, due_by)
      VALUES (${id}, ${threadId || null}, 'tenant_chat', ${ruleId || null},
        ${topic || 'unrecognised'}, ${language === 'zh' ? 'zh-Hant' : 'en'}, ${!sensitive},
        ${sensitive ? null : message}, ${role}, ${person?.id ?? null}, ${outboxId}, 'open', ${due})`;
    await tx`INSERT INTO notifications (id, audience, kind, code, params, link)
      VALUES (${notificationId}, ${role}, 'escalation', 'CHAT_CONFIRMATION_REQUIRED',
        ${JSON.stringify({ escalation_id: id, topic: topic || "unrecognised",
          rule_id: ruleId || null, assigned_to: person?.full_name ?? null,
          due_by: due })}, ${link})`;
  });
  return { id, assigned_role: role, notified: !!person };
}

/* Human-approved examples are training candidates, not live instructions.
   They remain pending until an administrator explicitly approves or excludes
   them in the Training Center. This specific route must precede /ai/:task. */
r.post("/ai/feedback", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const original = String(body.original ?? "").trim();
  const draft = String(body.draft ?? "").trim();
  const final = String(body.final ?? "").trim();
  if (!body.task || !original || !draft || !final)
    return c.json({ code: "MISSING_FIELDS" }, 400);
  if ([original, draft, final].some((value) => value.length > 20_000))
    return c.json({ code: "AI_FEEDBACK_TOO_LARGE" }, 413);

  const [row] = await c.get("db")`
    INSERT INTO ai_feedback_examples (id, task, source_ref_type, source_ref_id,
      original_input, ai_draft, approved_output, was_edited, model, created_by)
    VALUES (${`aif_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`},
      ${body.task}, ${body.ref_type ?? null}, ${body.ref_id ?? null}, ${original},
      ${draft}, ${final}, ${draft !== final},
      ${body.model ?? workersAiModel(c)}, ${c.get("user").id})
    RETURNING id, was_edited, created_at`;
  await audit(c, { action: "ai.feedback.captured", entityType: "ai_feedback",
    entityId: row.id, after: { task: body.task, was_edited: row.was_edited,
      review_status: "pending" } });
  return c.json({ feedback: row }, 201);
});

r.get("/admin/ai-training", adminOnly, async (c) => {
  const status = c.req.query("status") ?? "all";
  const task = c.req.query("task") ?? "all";
  const q = (c.req.query("q") ?? "").trim();
  const examples = await c.get("db")`
    SELECT f.id, f.task, f.source_ref_type, f.source_ref_id, f.original_input,
      f.ai_draft, f.approved_output, f.was_edited, f.model, f.review_status,
      f.exclusion_reason, f.created_at, f.reviewed_at,
      creator.full_name AS created_by_name, reviewer.full_name AS reviewed_by_name
    FROM ai_feedback_examples f
    LEFT JOIN users creator ON creator.id = f.created_by
    LEFT JOIN users reviewer ON reviewer.id = f.reviewed_by
    WHERE (${status} = 'all' OR f.review_status = ${status})
      AND (${task} = 'all' OR f.task = ${task})
      AND (${q} = '' OR f.original_input ILIKE ${`%${q}%`}
        OR f.approved_output ILIKE ${`%${q}%`})
    ORDER BY f.created_at DESC LIMIT 200`;
  const stats = await c.get("db")`
    SELECT review_status, COUNT(*)::int AS count
    FROM ai_feedback_examples GROUP BY review_status`;
  const rules = await c.get("db")`
    SELECT r.*, u.full_name AS updated_by_name
    FROM ai_training_rules r LEFT JOIN users u ON u.id = r.updated_by
    ORDER BY r.is_active DESC, r.updated_at DESC`;
  return c.json({ examples, stats, rules });
});

r.patch("/admin/ai-training/examples/:id", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!["pending", "approved", "excluded"].includes(body.status))
    return c.json({ code: "INVALID_STATUS" }, 400);
  const [before] = await c.get("db")`
    SELECT id, review_status, exclusion_reason FROM ai_feedback_examples
    WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const reason = body.status === "excluded" ? clipped(body.reason, 500).trim() || null : null;
  const [row] = await c.get("db")`
    UPDATE ai_feedback_examples SET review_status = ${body.status},
      reviewed_by = ${c.get("user").id}, reviewed_at = now(),
      excluded_at = ${body.status === "excluded" ? new Date().toISOString() : null},
      exclusion_reason = ${reason}
    WHERE id = ${before.id}
    RETURNING id, review_status, reviewed_at, exclusion_reason`;
  await audit(c, { action: "ai.training.review", entityType: "ai_feedback",
    entityId: row.id, before, after: row });
  return c.json({ example: row });
});

r.post("/admin/ai-training/rules", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = clipped(body.title, 120).trim();
  const instruction = clipped(body.instruction, 4000).trim();
  if (!title || !instruction) return c.json({ code: "MISSING_FIELDS" }, 400);
  const id = `air_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [row] = await c.get("db")`
    INSERT INTO ai_training_rules (id, title, instruction, task, created_by, updated_by)
    VALUES (${id}, ${title}, ${instruction}, ${body.task || null},
      ${c.get("user").id}, ${c.get("user").id}) RETURNING *`;
  await audit(c, { action: "ai.training.rule.create", entityType: "ai_training_rule",
    entityId: id, after: row });
  return c.json({ rule: row }, 201);
});

r.patch("/admin/ai-training/rules/:id", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const [before] = await c.get("db")`
    SELECT * FROM ai_training_rules WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code: "NOT_FOUND" }, 404);
  const title = body.title == null ? before.title : clipped(body.title, 120).trim();
  const instruction = body.instruction == null ? before.instruction : clipped(body.instruction, 4000).trim();
  if (!title || !instruction) return c.json({ code: "MISSING_FIELDS" }, 400);
  const [row] = await c.get("db")`
    UPDATE ai_training_rules SET title = ${title}, instruction = ${instruction},
      task = ${body.task === undefined ? before.task : body.task || null},
      is_active = ${body.is_active === undefined ? before.is_active : !!body.is_active},
      updated_by = ${c.get("user").id}, updated_at = now()
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action: "ai.training.rule.update", entityType: "ai_training_rule",
    entityId: row.id, before, after: row });
  return c.json({ rule: row });
});

/** Public tenant/prospect chat. Known questions are answered deterministically
 * from current database facts. Workers AI only handles safe questions that do
 * not map to a known live-data answer. Anything uncertain is a real staff
 * confirmation rather than a model guess. */
r.post("/public/ai/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = clipped(body.message, 2000).trim();
  const language = body.language === "zh" ? "zh" : "en";
  if (!message) return c.json({ code: "MESSAGE_REQUIRED" }, 400);

  try {
    const sql = c.get("db");
    const conversationKey = clipped(body.thread_id, 100) || null;
    const facts = await publicPropertyFacts(sql);
    const humanOnly = HUMAN_ONLY_PUBLIC.find((item) => item.re.test(message));
    if (humanOnly) {
      const escalation = await queuePublicConfirmation(sql, {
        message, language, topic:humanOnly.topic, ruleId:humanOnly.ruleId,
        threadId:conversationKey,
      });
      const text = language === "zh"
        ? "这个问题需要同事确认，我已经通知对应的工作人员。请直接联系办公室，以便我们回复你。"
        : "This needs confirmation from our team. The appropriate staff member has been notified; please contact the office so we can reply to you.";
      const runId = await recordAiRun(sql, {
        question:["R-101", "R-102", "R-103"].includes(humanOnly.ruleId)
          ? "[withheld: sensitive handoff]" : message,
        answer:text, language, provider:"human", conversationKey,
        needsHuman:true, escalationId:escalation.id,
        metadata:{ topic:humanOnly.topic, rule_id:humanOnly.ruleId },
      });
      return c.json({ text, automated:true, provider:"human", run_id:runId,
        needs_confirmation:true, escalation_id:escalation.id,
        assigned_role:escalation.assigned_role });
    }

    const answer = publicAnswer(message, facts, language === "zh");
    if (answer) {
      const runId = await recordAiRun(sql, { question:message, answer:answer.text,
        language, provider:"database", conversationKey,
        metadata:{ intent:answer.intent, snapshot_at:facts.snapshot_at } });
      return c.json({ text: answer.text, automated: true, provider:"database",
        run_id:runId, intent: answer.intent, snapshot_at: facts.snapshot_at });
    }

    let aiStatus = c.env.AI ? "AI_NO_USABLE_RESPONSE" : "AI_NOT_CONFIGURED";
    if (c.env.AI) {
      try {
        const learned = await trainingContext(c, "public_chat");
        const system = `${PROMPTS.public_chat}\n\nThis question has already passed the privacy and human-review safety rules. Give one useful plain-text answer using only the supplied public facts. If one detail is missing, state that it is not available while still answering the supported part. Never output JSON, Markdown, private data or unit numbers.${learned ? `\n\n${learned}` : ""}`;
        const result = await runWorkersAi(c.env.AI, workersAiModel(c), {
          messages: [
            { role:"system", content:system },
            { role:"user", content:`Visitor language: ${language}\nRecent conversation (may be empty):\n${clipped(body.history, 3000)}\n\nCurrent public property data:\n${JSON.stringify(facts)}\n\nVisitor question:\n${message}` },
          ],
          max_tokens: 220,
          temperature: 0.1,
        });
        const rawAnswer = workersAiText(result);
        const modelAnswer = clipped(rawAnswer, 3000).trim();
        // Sensitive and private topics were already removed above. For the
        // remaining safe public questions, show a truthful partial answer
        // instead of discarding it merely because the model marked the broad
        // question as needing more detail.
        if (modelAnswer) {
          const runId = await recordAiRun(sql, { question:message, answer:modelAnswer,
            language, provider:"workers_ai", model:workersAiModel(c), conversationKey,
            metadata:{ topic:"general", snapshot_at:facts.snapshot_at } });
          return c.json({ text:modelAnswer, automated:true, provider:"workers_ai",
            model:workersAiModel(c), run_id:runId, ai_status:"answered",
            needs_confirmation:false, snapshot_at:facts.snapshot_at });
        }
        aiStatus = "AI_INVALID_RESPONSE";
        await recordAiRun(sql, { question:message, answer:modelAnswer, language,
          provider:"workers_ai", model:workersAiModel(c), conversationKey,
          needsHuman:true, errorCode:aiStatus,
          metadata:{ topic:"unrecognised",
            response_received:!!rawAnswer, snapshot_at:facts.snapshot_at } });
      } catch (error) {
        aiStatus = error?.code === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_PROVIDER_ERROR";
        console.error("[public-workers-ai]", error?.message ?? error);
        await recordAiRun(sql, { question:message, language, provider:"workers_ai",
          model:workersAiModel(c), conversationKey, needsHuman:true,
          errorCode:aiStatus });
      }
    }

    const escalation = await queuePublicConfirmation(sql, {
      message, language, topic:"unrecognised", threadId:body.thread_id,
    });
    const text = language === "zh"
      ? "这个问题需要同事确认，我已经通知对应的工作人员。请直接联系办公室，以便我们回复你。"
      : "This needs confirmation from our team. The appropriate staff member has been notified; please contact the office so we can reply to you.";
    const runId = await recordAiRun(sql, { question:message, answer:text, language,
      provider:"human", conversationKey, needsHuman:true, escalationId:escalation.id,
      errorCode:aiStatus });
    return c.json({
      text, automated: true, provider:"human", run_id:runId,
      ai_status:aiStatus,
      needs_confirmation: true, escalation_id: escalation.id,
      assigned_role: escalation.assigned_role,
    });
  } catch (error) {
    console.error("[public-automation]", error?.message ?? error);
    return c.json({ code: "PUBLIC_AUTOMATION_ERROR" }, 500);
  }
});

/** Explicit or safety-rule handoff. This makes the handoff real: it records
 * the item and queues an email to the responsible active role. */
r.post("/public/chat/handoff", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = clipped(body.message, 2000).trim();
  if (!message) return c.json({ code:"MESSAGE_REQUIRED" }, 400);
  try {
    const escalation = await queuePublicConfirmation(c.get("db"), {
      message, language:body.language, topic:clipped(body.topic, 100),
      ruleId:clipped(body.rule_id, 30), threadId:clipped(body.thread_id, 100),
    }
    );
    return c.json({ ok:true, escalation_id:escalation.id,
      assigned_role:escalation.assigned_role, notified:escalation.notified }, 201);
  } catch (error) {
    console.error("[public-handoff]", error?.message ?? error);
    return c.json({ code:"HANDOFF_ERROR" }, 500);
  }
});

/** Real confirmation queue for staff. Each role sees only its own work;
 * administrators can see the whole queue. */
r.get("/escalations", async (c) => {
  const user = c.get("user");
  const rows = await c.get("db")`
    SELECT e.id, e.source, e.rule_id, e.topic, e.locale, e.body_included,
      e.body, e.assigned_role, e.state, e.due_by, e.created_at,
      e.claimed_name, e.claimed_at, e.answered_at, e.answer_body,
      assignee.full_name AS assigned_to_name
    FROM escalations e
    LEFT JOIN users assignee ON assignee.id = e.assigned_to
    WHERE (${user.role === "admin"} OR e.assigned_role = ${user.role})
      AND (e.state IN ('open', 'claimed') OR e.created_at > now() - INTERVAL '30 days')
    ORDER BY
      CASE WHEN e.state IN ('open', 'claimed') AND e.due_by::timestamptz < now()
        THEN 0 ELSE 1 END,
      e.created_at DESC
    LIMIT 200`;
  return c.json({ escalations: rows });
});

r.post("/escalations/:id/confirm", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const note = clipped(body.note, 1000).trim();
  const [before] = await c.get("db")`
    SELECT * FROM escalations WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code:"NOT_FOUND" }, 404);
  if (user.role !== "admin" && before.assigned_role !== user.role)
    return c.json({ code:"FORBIDDEN" }, 403);
  if (!['open', 'claimed'].includes(before.state))
    return c.json({ code:"ALREADY_HANDLED", escalation:before }, 409);

  const [row] = await c.get("db")`
    UPDATE escalations SET state = 'closed', claimed_by = ${user.id},
      claimed_name = ${user.name}, claimed_at = COALESCE(claimed_at, now()),
      answered_at = now(), answer_body = ${note || 'Confirmed by staff'}
    WHERE id = ${before.id} RETURNING *`;
  await audit(c, { action:"escalation.confirm", entityType:"escalation",
    entityId:row.id, before, after:row });
  return c.json({ escalation:row });
});

/** Administrators may remove an invalid or test escalation. Related queued
 * messages and the matching notification are removed in the same transaction
 * so a deleted test cannot still email somebody or leave a badge behind. */
r.delete("/escalations/:id", adminOnly, async (c) => {
  const [before] = await c.get("db")`
    SELECT * FROM escalations WHERE id = ${c.req.param("id")}`;
  if (!before) return c.json({ code:"NOT_FOUND" }, 404);

  const removed = await c.get("db").begin(async (tx) => {
    const notifications = await tx`
      DELETE FROM notifications
      WHERE kind = 'escalation' AND params IS NOT NULL
        AND params::jsonb ->> 'escalation_id' = ${before.id}
      RETURNING id`;
    await tx`DELETE FROM escalations WHERE id = ${before.id}`;
    const outbox = await tx`
      DELETE FROM outbox
      WHERE (ref_type = 'escalation' AND ref_id = ${before.id})
         OR id = ${before.outbox_id}
      RETURNING id`;
    return { notifications:notifications.length, outbox:outbox.length };
  });

  await audit(c, { action:"escalation.delete", entityType:"escalation",
    entityId:before.id, before,
    after:{ deleted:true, notifications:removed.notifications, outbox:removed.outbox } });
  return c.json({ ok:true, id:before.id, removed });
});

r.post("/ai/:task", async (c) => {
  const task = c.req.param("task");
  const body = await c.req.json().catch(() => ({}));
  const input = body.input ?? {};
  let inboxRoute = null;
  let inboxFacts = {};
  let inboxMissingInfo = null;
  let encoded;

  if (task === "inbox_draft") {
    const message = clipped(input.message, 5000).trim();
    if (!message) return c.json({ code: "MESSAGE_REQUIRED" }, 400);
    inboxRoute = routeStaffMessage(message);
    if (inboxRoute.dataTopics.length) {
      try {
        const liveFacts = await publicPropertyFacts(c.get("db"));
        inboxFacts = staffFactsForTopics(liveFacts, inboxRoute.dataTopics);
      } catch (error) {
        console.error("[inbox-live-facts]", error?.message ?? error);
        inboxMissingInfo = "Live property data is temporarily unavailable; staff confirmation is required.";
      }
    }
    inboxMissingInfo = inboxMissingInfo ?? staffMissingInfo(inboxRoute);
    encoded = JSON.stringify({
      customer_message: message,
      channel: clipped(input.channel, 30),
      routed_intent: inboxRoute.intent,
      detected_topics: inboxRoute.topics,
      relevant_property_facts: inboxFacts,
      missing_information: inboxMissingInfo,
    });
  } else {
    encoded = JSON.stringify(input);
  }
  if (encoded.length > 80_000) return c.json({ code: "AI_INPUT_TOO_LARGE" }, 413);
  if (!c.env.AI) {
    if (task === "inbox_draft" && inboxRoute) {
      const text = staffDraftResult({ route:inboxRoute,
        draft:staffFallbackDraft(input.message, inboxRoute), selectedFacts:inboxFacts,
        missingInfo:inboxMissingInfo ?? "The AI provider is not configured; staff review is required.",
        fallback:true });
      return c.json({ text, provider:"fallback", ai_status:"AI_NOT_CONFIGURED" });
    }
    return c.json({ code: "AI_NOT_CONFIGURED" }, 503);
  }

  const learned = await trainingContext(c, task);
  const system = (PROMPTS[task] ??
    `Assist a property-management employee with the named task. Use only supplied facts, do not take actions, move money, make legal decisions, or promise an outcome. Return a draft for human review.`)
    + (learned ? `\n\n${learned}` : "");
  let result;
  try {
    result = await runWorkersAi(c.env.AI, workersAiModel(c), {
      messages: [
        { role:"system", content:system },
        { role:"user", content:`Task: ${task}\nFacts/input:\n${encoded}` },
      ],
      max_tokens: 1400,
      temperature: 0.1,
    });
  } catch (error) {
    console.error("[ai]", task, error?.message ?? error);
    const code = error?.code === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_PROVIDER_ERROR";
    if (task === "inbox_draft" && inboxRoute) {
      const fallback = staffFallbackDraft(input.message, inboxRoute);
      const text = staffDraftResult({ route:inboxRoute, draft:fallback,
        selectedFacts:inboxFacts,
        missingInfo:inboxMissingInfo ?? "The AI provider was unavailable; staff review is required.",
        fallback:true });
      await recordAiRun(c.get("db"), { source:"staff_task",
        question:`Task: ${task}`, answer:text, language:"en", provider:"fallback",
        model:workersAiModel(c), needsHuman:true, errorCode:code,
        metadata:{ ref_type:body.ref_type ?? null, ref_id:body.ref_id ?? null,
          routed_intent:inboxRoute.intent, data_topics:inboxRoute.dataTopics } });
      return c.json({ text, model:workersAiModel(c), provider:"fallback",
        ai_status:code });
    }
    await recordAiRun(c.get("db"), { source:"staff_task",
      question:`Task: ${task}`, language:"en", provider:"workers_ai",
      model:workersAiModel(c), needsHuman:true, errorCode:code,
      metadata:{ ref_type:body.ref_type ?? null, ref_id:body.ref_id ?? null } });
    return c.json({ code }, code === "AI_TIMEOUT" ? 504 : 502);
  }
  const rawText = workersAiText(result);
  const text = task === "inbox_draft" && inboxRoute
    ? staffDraftResult({ route:inboxRoute,
      draft:rawText || staffFallbackDraft(input.message, inboxRoute),
      selectedFacts:inboxFacts,
      missingInfo:rawText ? inboxMissingInfo
        : (inboxMissingInfo ?? "The AI returned no draft; staff review is required."),
      fallback:!rawText })
    : rawText;
  if (!text) {
    await recordAiRun(c.get("db"), { source:"staff_task",
      question:`Task: ${task}`, language:"en", provider:"workers_ai",
      model:workersAiModel(c), needsHuman:true, errorCode:"AI_EMPTY_RESPONSE",
      metadata:{ ref_type:body.ref_type ?? null, ref_id:body.ref_id ?? null } });
    return c.json({ code: "AI_EMPTY_RESPONSE" }, 502);
  }
  const model = workersAiModel(c);
  await recordAiRun(c.get("db"), { source:"staff_task", question:`Task: ${task}`,
    answer:text, language:"en", provider:"workers_ai", model,
    metadata:{ ref_type:body.ref_type ?? null, ref_id:body.ref_id ?? null,
      input_chars:encoded.length } });
  await audit(c, { action: `ai.${task}`, entityType: body.ref_type ?? "ai_task",
    entityId: body.ref_id ?? null, after: { model, provider:"cloudflare_workers_ai",
      input_chars: encoded.length,
      output_chars: text.length } });
  return c.json({ text, model, provider:"cloudflare_workers_ai" });
});

export default r;
