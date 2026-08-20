import { Hono } from "hono";
import { require_, audit, uid } from "../lib/auth.js";

const r = new Hono();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["image/avif", "avif"],
]);
const SLOTS = new Set(["hero", "amenities", "neighbourhood", "gallery"]);
const COPY_FIELDS = ["headline", "subheadline", "intro_title", "intro_body",
  "amenities_title", "amenities_body", "neighbourhood_title", "neighbourhood_body",
  "gallery_title", "cta_title", "cta_body"];

const DEFAULT_CONTENT = {
  en: {
    headline: "A short walk from Clareview LRT.",
    subheadline: "Three buildings, 330 homes and everyday amenities in one connected Edmonton community.",
    intro_title: "A place that keeps daily life close",
    intro_body: "Choose from one- and two-bedroom homes across 370, 374 and 378 Clareview Station Drive NW. Each building has spaces to work out, unwind and care for your pets.",
    amenities_title: "More than a place to sleep",
    amenities_body: "A gym, lounge, games room, pet wash and bicycle storage are available in every building, with shared outdoor space across the site.",
    neighbourhood_title: "Clareview at your door",
    neighbourhood_body: "Walk to Clareview LRT and connect to downtown, shopping, recreation and the rest of Edmonton without adding another stop to your day.",
    gallery_title: "See Baydo Pointe",
    cta_title: "Find the home that fits",
    cta_body: "Check current availability and live pricing, then book a viewing when you are ready.",
  },
  zh: {
    headline: "走路就到 Clareview 輕軌站。",
    subheadline: "三棟樓、330 戶住宅與日常配套，組成交通便利的 Edmonton 社區。",
    intro_title: "讓日常生活更方便",
    intro_body: "370、374、378 Clareview Station Drive NW 提供一房與兩房戶型。每棟樓都有健身、休閒與寵物照護空間。",
    amenities_title: "不只是一處住所",
    amenities_body: "每棟樓均設健身房、Lounge、遊戲室、寵物清洗間與自行車儲存空間，社區另有共享戶外區域。",
    neighbourhood_title: "Clareview 就在門口",
    neighbourhood_body: "步行可達 Clareview LRT，輕鬆前往市中心、購物、休閒設施與 Edmonton 其他地區。",
    gallery_title: "看看 Baydo Pointe",
    cta_title: "找到適合你的房型",
    cta_body: "查看即時空房與租金，準備好後即可預約看房。",
  },
  contact: { phone: "780-937-8677", email: "rentals@themizar.ca" },
};

const clean = (value, max = 1500) => String(value ?? "").trim().slice(0, max);
const safeFilename = (value, fallback = "photo") => {
  const name = String(value ?? "").split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || fallback;
};
const mergeContent = (stored = {}) => ({
  en: { ...DEFAULT_CONTENT.en, ...(stored.en ?? {}) },
  zh: { ...DEFAULT_CONTENT.zh, ...(stored.zh ?? {}) },
  contact: { ...DEFAULT_CONTENT.contact, ...(stored.contact ?? {}) },
});
const publicImage = (row) => ({
  id: row.id, slot: row.slot, filename: row.filename, alt_en: row.alt_en,
  alt_zh: row.alt_zh, sort_order: row.sort_order,
  url: `/api/public/site-images/${encodeURIComponent(row.id)}`,
});

async function readSite(sql) {
  const [settings] = await sql`SELECT content, updated_at FROM public_site_settings WHERE id = 'main'`;
  const images = await sql`SELECT id, slot, filename, alt_en, alt_zh, sort_order
    FROM public_site_images WHERE is_active
    ORDER BY CASE slot WHEN 'hero' THEN 0 WHEN 'amenities' THEN 1
      WHEN 'neighbourhood' THEN 2 ELSE 3 END, sort_order, created_at`;
  return { content: mergeContent(settings?.content), images: images.map(publicImage),
    updated_at: settings?.updated_at ?? null };
}

r.get("/public/site-content", async (c) => {
  const site = await readSite(c.get("db"));
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return c.json(site);
});

r.get("/public/site-images/:id", async (c) => {
  const [image] = await c.get("db")`SELECT storage_key, mime_type, filename
    FROM public_site_images WHERE id = ${c.req.param("id")} AND is_active`;
  if (!image) return c.json({ code: "NOT_FOUND" }, 404);
  if (!c.env.FILES) return c.json({ code: "FILE_STORAGE_NOT_CONFIGURED" }, 503);
  const object = await c.env.FILES.get(image.storage_key);
  if (!object) return c.json({ code: "FILE_NOT_FOUND" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", image.mime_type);
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Disposition", `inline; filename="${safeFilename(image.filename)}"`);
  return new Response(object.body, { headers });
});

r.get("/admin/site-content", require_("users.manage"), async (c) => {
  const site = await readSite(c.get("db"));
  return c.json({ ...site, public_url: c.env.PUBLIC_TENANT_URL ?? null });
});

r.put("/admin/site-content", require_("users.manage"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const input = body.content ?? {};
  const content = { en: {}, zh: {}, contact: {} };
  for (const locale of ["en", "zh"])
    for (const field of COPY_FIELDS)
      content[locale][field] = clean(input?.[locale]?.[field]);
  content.contact.phone = clean(input?.contact?.phone, 80);
  content.contact.email = clean(input?.contact?.email, 160).toLowerCase();
  if (content.contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content.contact.email))
    return c.json({ code: "INVALID_CONTACT_EMAIL" }, 400);

  const user = c.get("user");
  const [saved] = await c.get("db")`INSERT INTO public_site_settings (id, content, updated_by, updated_at)
    VALUES ('main', ${JSON.stringify(content)}, ${user.id}, now())
    ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING updated_at`;
  await audit(c, { action: "public_site.content.update", entityType: "public_site",
    entityId: "main", after: { updated_at: saved.updated_at } });
  return c.json({ content: mergeContent(content), updated_at: saved.updated_at });
});

r.post("/admin/site-images", require_("users.manage"), async (c) => {
  if (!c.env.FILES) return c.json({ code: "FILE_STORAGE_NOT_CONFIGURED" }, 503);
  const body = await c.req.parseBody().catch(() => ({}));
  const file = body.file;
  const slot = clean(body.slot, 30);
  if (!SLOTS.has(slot)) return c.json({ code: "INVALID_IMAGE_SLOT" }, 400);
  if (!file || typeof file.arrayBuffer !== "function") return c.json({ code: "FILE_REQUIRED" }, 400);
  if (!IMAGE_TYPES.has(file.type)) return c.json({ code: "IMAGE_TYPE_NOT_ALLOWED" }, 415);
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES)
    return c.json({ code: "IMAGE_SIZE_NOT_ALLOWED", max_bytes: MAX_IMAGE_BYTES }, 413);

  const sql = c.get("db");
  const user = c.get("user");
  const id = uid("psi_");
  const filename = safeFilename(file.name, `photo.${IMAGE_TYPES.get(file.type)}`);
  const key = `public-site/${slot}/${id}-${filename}`;
  await c.env.FILES.put(key, new Uint8Array(await file.arrayBuffer()), {
    httpMetadata: { contentType: file.type },
    customMetadata: { slot, uploaded_by: user.id },
  });
  try {
    const result = await sql.begin(async (tx) => {
      const replaced = slot === "gallery" ? [] : await tx`
        SELECT storage_key FROM public_site_images WHERE slot = ${slot} FOR UPDATE`;
      if (slot !== "gallery") await tx`DELETE FROM public_site_images WHERE slot = ${slot}`;
      const [row] = await tx`INSERT INTO public_site_images (id, slot, storage_key,
        filename, mime_type, size_bytes, alt_en, alt_zh, sort_order, uploaded_by)
        VALUES (${id}, ${slot}, ${key}, ${filename}, ${file.type}, ${file.size},
          ${clean(body.alt_en, 240)}, ${clean(body.alt_zh, 240)},
          ${Number(body.sort_order) || 0}, ${user.id}) RETURNING *`;
      return { row, replaced };
    });
    const image = result.row;
    for (const old of result.replaced) await c.env.FILES.delete(old.storage_key).catch(() => {});
    await audit(c, { action: "public_site.image.upload", entityType: "public_site_image",
      entityId: id, after: { slot, filename } });
    return c.json({ image: publicImage(image) }, 201);
  } catch (error) {
    await c.env.FILES.delete(key).catch(() => {});
    throw error;
  }
});

r.delete("/admin/site-images/:id", require_("users.manage"), async (c) => {
  const sql = c.get("db");
  const [image] = await sql`DELETE FROM public_site_images WHERE id = ${c.req.param("id")}
    RETURNING id, slot, storage_key, filename`;
  if (!image) return c.json({ code: "NOT_FOUND" }, 404);
  if (c.env.FILES) await c.env.FILES.delete(image.storage_key).catch(() => {});
  await audit(c, { action: "public_site.image.delete", entityType: "public_site_image",
    entityId: image.id, before: { slot: image.slot, filename: image.filename } });
  return c.json({ ok: true });
});

export default r;
