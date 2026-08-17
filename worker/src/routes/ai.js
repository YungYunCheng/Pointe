import { Hono } from "hono";
import { audit } from "../lib/auth.js";

const r = new Hono();

const PROMPTS = {
  inbox_draft: `Classify a property-management message and draft a concise reply using only the supplied facts. Output JSON only: {"intent":"one supplied intent","confidence":0.0,"draft":"reply","facts_used":[],"missing_info":null}. Never invent prices, availability, policy, legal conclusions, or promises. If facts are missing, say so in missing_info.`,
  intake_question: `Help collect lease-intake fields. Extract only clearly stated values. Ask one neutral question at a time and do not ask about protected personal characteristics. Output JSON only: {"extracted":{},"next_question":"question or null","done":false}.`,
  template_fields: `Identify fillable fields explicitly present in the supplied approved document text. Output a JSON array only. Each item must have key, label, source_text and confidence. Do not add clauses or legal language.`,
  document_convert: `Reformat the supplied document content for the requested operational target without changing its meaning, amounts, clauses, or obligations. Return only the converted content.`,
  entry_notice: `Draft a clear bilingual English and Traditional Chinese notice of entry using only the supplied unit, date, time window and purpose. Do not add legal claims or change the time. Return notice text only for staff review.`,
  purchase_order: `Draft a purchase-order description, scope and expense lines from the maintenance facts. Output JSON only with description, scope, gl_code, lines and needs_quote. Amounts must be blank unless a vendor quote is supplied.`,
  parking_advice: `Analyse the supplied parking allocation facts. Explain operational risks and practical next checks without inventing availability or policy. Return concise staff guidance.`,
  report_narrative: `Turn the supplied accounting figures into a concise factual management narrative. Do not change or infer figures. Flag missing comparisons.`,
  public_chat: `Answer a prospective tenant using only the supplied public property data and approved company rules. Reply in the visitor's language. Never invent or guarantee availability, rent, fees, parking, dates, policies, approval, a reservation or an outcome. Counts are a current snapshot and may change. If the answer is not present, say the leasing team must confirm it. Do not reveal unit numbers, tenant information, leases, payments, vehicle information or internal notes. Keep the answer concise and do not output JSON.`,
};

const adminOnly = async (c, next) => {
  if (c.get("user")?.role !== "admin") return c.json({ code: "FORBIDDEN" }, 403);
  return next();
};

const clipped = (value, max = 4000) => String(value ?? "").slice(0, max);

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

  return {
    property: "Baydo Pointe, Clareview, Edmonton",
    snapshot_at: new Date().toISOString(),
    unit_types: types,
    parking,
    fees: fees ?? null,
  };
}

function responseText(result) {
  return (result.output ?? [])
    .flatMap((item) => item.type === "message" ? (item.content ?? []) : [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "").join("\n");
}

const PUBLIC_INTENTS = {
  parking: /parking|park\b|stall|車位|停车|停車/i,
  pets: /\bpet|\bdog|\bcat|animal|寵物|宠物|養狗|养狗|養貓|养猫|貓|猫|狗/i,
  rent: /\brent|price|pricing|how much|monthly|租金|多少錢|多少钱|價錢|价钱|價格|价格/i,
  availability: /available|availability|vacan|empty unit|suite|unit|空房|空屋|幾套|几套|還有|还有|入住|move.?in/i,
  fees: /deposit|storage|application fee|utilit|included|費用|费用|押金|保證金|保证金|儲物|储物|水電|水电|包含/i,
  amenities: /amenit|gym|lounge|game room|bike|健身|休息室|遊戲室|游戏室|自行車|自行车/i,
  location: /address|location|where|transit|lrt|地址|位置|在哪|交通|地鐵|地铁/i,
};

const money = (value) => value == null || value === "" || !Number.isFinite(Number(value))
  ? null : `$${Math.round(Number(value)).toLocaleString("en-CA")}`;
const dateText = (value, zh) => value ? new Date(`${String(value).slice(0, 10)}T12:00:00Z`)
  .toLocaleDateString(zh ? "zh-TW" : "en-CA", { year:"numeric", month:"long", day:"numeric", timeZone:"UTC" }) : null;
const unitTypeFrom = (message) => {
  const m = String(message).toUpperCase().match(/(?:^|\s|[^A-Z0-9])(1A|1B|1C|2A|3A)(?:\s*\(M\)|\s*M)?(?:$|\s|[^A-Z0-9])/);
  return m?.[1] ?? null;
};

function publicAnswer(message, facts, zh) {
  const type = unitTypeFrom(message);
  const unit = type ? facts.unit_types.find((x) => x.code === type) : null;
  const intent = Object.entries(PUBLIC_INTENTS).find(([, re]) => re.test(message))?.[0];
  const snapshot = zh ? "空房與車位為目前資料，可能隨時變動。" : "Availability is a current snapshot and may change.";

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
      ${body.model ?? c.env.OPENAI_MODEL ?? "gpt-5.6-luna"}, ${c.get("user").id})
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
 * from current database facts. No model call, API key or usage charge. */
r.post("/public/ai/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = clipped(body.message, 2000).trim();
  const language = body.language === "zh" ? "zh" : "en";
  if (!message) return c.json({ code: "MESSAGE_REQUIRED" }, 400);

  try {
    const facts = await publicPropertyFacts(c.get("db"));
    const answer = publicAnswer(message, facts, language === "zh");
    if (answer) return c.json({ text: answer.text, automated: true,
      intent: answer.intent, snapshot_at: facts.snapshot_at });

    const escalation = await queuePublicConfirmation(c.get("db"), {
      message, language, topic:"unrecognised", threadId:body.thread_id,
    });
    return c.json({
      text: language === "zh"
        ? "这个问题需要同事确认，我已经通知对应的工作人员。请直接联系办公室，以便我们回复你。"
        : "This needs confirmation from our team. The appropriate staff member has been notified; please contact the office so we can reply to you.",
      automated: true, needs_confirmation: true, escalation_id: escalation.id,
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

r.post("/ai/:task", async (c) => {
  const task = c.req.param("task");
  const body = await c.req.json().catch(() => ({}));
  const input = body.input ?? {};
  const encoded = JSON.stringify(input);
  if (encoded.length > 80_000) return c.json({ code: "AI_INPUT_TOO_LARGE" }, 413);
  if (!c.env.OPENAI_API_KEY) return c.json({ code: "AI_NOT_CONFIGURED" }, 503);

  const learned = await trainingContext(c, task);
  const system = (PROMPTS[task] ??
    `Assist a property-management employee with the named task. Use only supplied facts, do not take actions, move money, make legal decisions, or promise an outcome. Return a draft for human review.`)
    + (learned ? `\n\n${learned}` : "");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${c.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: c.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      max_output_tokens: 1400,
      reasoning: { effort: "low" },
      instructions: system,
      input: [{ role: "user", content: `Task: ${task}\nFacts/input:\n${encoded}` }],
    }),
  });
  if (!response.ok) {
    console.error("[ai]", task, response.status);
    return c.json({ code: "AI_PROVIDER_ERROR" }, 502);
  }
  const result = await response.json();
  const text = responseText(result);
  if (!text) return c.json({ code: "AI_EMPTY_RESPONSE" }, 502);
  await audit(c, { action: `ai.${task}`, entityType: body.ref_type ?? "ai_task",
    entityId: body.ref_id ?? null, after: { model: result.model, input_chars: encoded.length,
      output_chars: text.length } });
  return c.json({ text, model: result.model });
});

export default r;
