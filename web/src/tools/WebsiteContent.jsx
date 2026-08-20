import React, { useCallback, useEffect, useState } from "react";
import api from "../lib/api.js";

const FIELDS = [
  ["headline", "Main headline"], ["subheadline", "Opening summary"],
  ["intro_title", "Introduction title"], ["intro_body", "Introduction text"],
  ["amenities_title", "Amenities title"], ["amenities_body", "Amenities text"],
  ["neighbourhood_title", "Neighbourhood title"], ["neighbourhood_body", "Neighbourhood text"],
  ["gallery_title", "Gallery title"], ["cta_title", "Final call-to-action title"],
  ["cta_body", "Final call-to-action text"],
];
const FOOTER_FIELDS = [
  ["footer_tagline", "Footer summary"],
  ["footer_address", "Footer address"],
];
const SLOTS = [
  ["hero", "Hero photos", "Large opening photos on the home page"],
  ["amenities", "Amenities photos", "Gym, lounge, pet wash or another shared space"],
  ["neighbourhood", "Neighbourhood photos", "Exterior, LRT or the surrounding area"],
];
const stamp = (value) => value ? String(value).slice(0, 16).replace("T", " ") : "—";

export default function WebsiteContent() {
  const [site, setSite] = useState(null);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await api.websiteContent();
      setSite(data); setContent(data.content);
    } catch (e) {
      setError(e.code === "INTERNAL_ERROR"
        ? "Run migration 022_public_website_content.sql in Supabase, then refresh."
        : `Could not load website content (${e.code ?? "unknown error"}).`);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (message) => { setNotice(message); setTimeout(() => setNotice(""), 3500); };
  const setCopy = (locale, field, value) => setContent((old) => ({ ...old,
    [locale]: { ...old[locale], [field]: value } }));
  const setContact = (field, value) => setContent((old) => ({ ...old,
    contact: { ...old.contact, [field]: value } }));
  const images = (slot) => (site?.images ?? []).filter((image) => image.slot === slot);

  const save = async () => {
    setSaving(true); setError("");
    try { const result = await api.saveWebsiteContent(content); setContent(result.content); flash("Website copy published."); }
    catch (e) { setError(e.code === "INVALID_CONTACT_EMAIL" ? "Enter a valid office email."
      : `Could not publish (${e.code ?? "unknown error"}).`); }
    finally { setSaving(false); }
  };

  const upload = async (slot, fileList) => {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    setBusy(slot); setError("");
    try {
      const offset = images(slot).length;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > 10 * 1024 * 1024) throw Object.assign(new Error(), { code:"IMAGE_SIZE_NOT_ALLOWED" });
        await api.uploadWebsiteImage(file, slot, file.name.replace(/\.[^.]+$/, ""), "", offset + i);
      }
      flash(`${files.length} photo${files.length === 1 ? "" : "s"} uploaded.`); await load();
    } catch (e) {
      setError(e.code === "IMAGE_SIZE_NOT_ALLOWED" ? "Each photo must be 10 MB or smaller."
        : e.code === "IMAGE_TYPE_NOT_ALLOWED" ? "Use JPG, PNG, WebP or AVIF."
        : e.code === "IMAGE_SLOT_LIMIT" ? "A section can contain up to 20 photos."
        : `Could not upload (${e.code ?? "unknown error"}).`);
    } finally { setBusy(""); }
  };

  const remove = async (image) => {
    setBusy(image.id); setError("");
    try { await api.deleteWebsiteImage(image.id); flash("Photo removed."); await load(); }
    catch (e) { setError(`Could not remove photo (${e.code ?? "unknown error"}).`); }
    finally { setBusy(""); }
  };

  if (loading) return <main className="wc"><style>{CSS}</style><div className="wc-empty">Loading website content…</div></main>;
  if (!content) return <main className="wc"><style>{CSS}</style><div className="wc-error">{error}</div><button onClick={load}>Try again</button></main>;

  return <main className="wc"><style>{CSS}</style>
    <header className="wc-head"><div><small>Baydo Pointe · Admin</small><h1>Website content</h1>
      <p>Edit the public leasing home page without changing live availability, pricing, bookings, applications, the portal or chat.</p></div>
      <div>{notice && <span className="wc-ok">{notice}</span>}{site?.public_url && <a className="wc-btn ghost" href={site.public_url} target="_blank" rel="noreferrer">Open website ↗</a>}</div>
    </header>
    {error && <div className="wc-error">{error}</div>}

    <section className="wc-card"><div className="wc-cardhead"><div><h2>English and Chinese copy</h2><p>Both languages publish together.</p></div></div>
      <div className="wc-copy">{["en", "zh"].map((locale) => <div className="wc-lang" key={locale}><h3>{locale === "en" ? "English" : "中文"}</h3>
        {FIELDS.map(([field, label]) => <label key={field}><span>{label}</span><textarea rows={field.includes("body") || field === "subheadline" ? 4 : 2}
          value={content[locale]?.[field] ?? ""} onChange={(e) => setCopy(locale, field, e.target.value)} /></label>)}</div>)}</div>
      <div className="wc-actions"><button className="wc-btn" disabled={saving} onClick={save}>{saving ? "Publishing…" : "Publish website copy"}</button><span>Live rent and vacancy data are not changed.</span></div>
    </section>

    <section className="wc-card"><div className="wc-cardhead"><div><h2>Page photos</h2><p>Every section accepts several photos and shows them as a slideshow. JPG, PNG, WebP or AVIF · maximum 10 MB each.</p></div></div>
      <div className="wc-slots">{SLOTS.map(([slot, label, hint]) => { const sectionImages = images(slot); return <article key={slot}>
        <div className="wc-slotcopy"><div className="wc-slot-title"><div><strong>{label}</strong><p>{hint}</p></div><Upload multiple label={busy === slot ? "Uploading…" : "Add photos"} disabled={!!busy} onFiles={(files) => upload(slot, files)} /></div>
          <div className="wc-mini-grid">{sectionImages.length ? sectionImages.map((image) => <figure key={image.id}><img src={image.url} alt="" /><button aria-label="Remove" disabled={!!busy} onClick={() => remove(image)}>×</button></figure>) : <div className="wc-empty">No photos yet.</div>}</div></div></article>; })}</div>
      <div className="wc-gallery"><div className="wc-cardhead"><div><h2>Gallery</h2><p>Upload several photos at once.</p></div><Upload multiple label={busy === "gallery" ? "Uploading…" : "Add gallery photos"} disabled={!!busy} onFiles={(files) => upload("gallery", files)} /></div>
        <div className="wc-grid">{images("gallery").length ? images("gallery").map((image) => <figure key={image.id}><img src={image.url} alt="" /><button aria-label="Remove" disabled={!!busy} onClick={() => remove(image)}>×</button><figcaption>{image.filename}</figcaption></figure>) : <div className="wc-empty">No gallery photos yet.</div>}</div>
      </div>
    </section>
    <section className="wc-card"><div className="wc-cardhead"><div><h2>Footer</h2><p>Controls the dark footer at the bottom of every public page.</p></div></div>
      <div className="wc-row"><Field label="Office phone" value={content.contact?.phone ?? ""} onChange={(v) => setContact("phone", v)} />
        <Field label="Office email" type="email" value={content.contact?.email ?? ""} onChange={(v) => setContact("email", v)} /></div>
      <div className="wc-copy wc-footer-copy">{["en", "zh"].map((locale) => <div className="wc-lang" key={locale}><h3>{locale === "en" ? "English footer" : "中文 Footer"}</h3>
        {FOOTER_FIELDS.map(([field, label]) => <label key={field}><span>{label}</span><textarea rows={field === "footer_address" ? 3 : 2} value={content[locale]?.[field] ?? ""} onChange={(e) => setCopy(locale, field, e.target.value)} /></label>)}</div>)}</div>
      <div className="wc-actions"><button className="wc-btn" disabled={saving} onClick={save}>{saving ? "Publishing…" : "Publish footer"}</button></div>
    </section>
    <footer>Last published {stamp(site?.updated_at)}</footer>
  </main>;
}

function Field({ label, value, onChange, type = "text" }) {
  return <label className="wc-field"><span>{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Upload({ label, onFiles, disabled, multiple = false }) {
  return <label className="wc-btn upload"><input type="file" multiple={multiple} disabled={disabled} accept="image/jpeg,image/png,image/webp,image/avif" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />{label}</label>;
}

const CSS = `
.wc{--ink:#142C50;--dim:#75879A;--rule:#D4DDE4;--ground:#EEF2F5;min-height:100vh;background:var(--ground);padding:28px;color:#17212B;font:14px/1.55 'IBM Plex Sans',system-ui,sans-serif}.wc *{box-sizing:border-box}.wc-head{display:flex;justify-content:space-between;gap:25px;align-items:flex-end;max-width:1380px;margin:0 0 18px}.wc-head small{font:11px 'IBM Plex Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}.wc h1{font:800 30px 'Archivo',sans-serif;color:var(--ink);margin:5px 0}.wc-head p,.wc-cardhead p{margin:0;color:var(--dim);max-width:70ch}.wc-head>div:last-child{display:flex;gap:8px;align-items:center}.wc-card{max-width:1380px;background:#fff;border:1px solid var(--rule);border-radius:6px;padding:20px;margin-bottom:15px}.wc-cardhead{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;margin-bottom:16px}.wc h2{font:700 18px 'Archivo',sans-serif;color:var(--ink);margin:0 0 3px}.wc-row{display:flex;gap:12px}.wc-field{flex:1;display:flex;flex-direction:column;gap:5px}.wc label>span,.wc-lang label>span{font-size:12px;font-weight:600;color:#3E4C5A}.wc input,.wc textarea{font:inherit;width:100%;border:1px solid var(--rule);border-radius:4px;padding:9px 10px;color:#17212B;background:#fff}.wc textarea{resize:vertical;line-height:1.5}.wc input:focus,.wc textarea:focus{outline:2px solid var(--ink);outline-offset:1px}.wc-copy{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.wc-footer-copy{margin-top:14px}.wc-lang{border:1px solid var(--rule);border-radius:5px;padding:15px;display:flex;flex-direction:column;gap:12px}.wc-lang h3{font:600 12px 'IBM Plex Mono',monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0}.wc-lang label{display:flex;flex-direction:column;gap:5px}.wc-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:15px}.wc-actions>span{font-size:12px;color:var(--dim)}.wc-btn{display:inline-flex;align-items:center;justify-content:center;font:600 13px 'IBM Plex Sans',sans-serif;color:#fff;background:var(--ink);border:1px solid var(--ink);border-radius:4px;padding:8px 15px;text-decoration:none;cursor:pointer}.wc-btn.ghost{color:#3E4C5A;background:#fff;border-color:var(--rule)}.wc-btn:disabled{opacity:.45;cursor:not-allowed}.wc-ok{color:#087F71;border:1px solid #087F71;background:#F4FAF8;padding:6px 10px;border-radius:4px;font-size:12px}.wc-error{max-width:1380px;color:#B23A54;border:1px solid #B23A54;background:#FFF8F9;border-radius:4px;padding:10px 13px;margin-bottom:14px}.wc-slots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.wc-slots article{border:1px solid var(--rule);border-radius:5px;overflow:hidden}.wc-slotcopy{padding:12px}.wc-slotcopy p{font-size:11.5px;color:var(--dim);margin:3px 0}.wc-slot-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.wc-slot-title .wc-btn{flex:0 0 auto}.wc-mini-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:12px}.wc-mini-grid figure{margin:0;position:relative;border-radius:3px;overflow:hidden;background:#E5EBEF}.wc-mini-grid img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}.wc-mini-grid button,.wc-grid figure button{position:absolute;right:5px;top:5px;border:0;border-radius:50%;background:rgba(255,255,255,.92);width:28px;height:28px;font-size:18px;cursor:pointer}.wc-mini-grid .wc-empty{grid-column:1/-1;padding:24px}.wc-btn.upload{position:relative}.wc-btn.upload input{position:absolute;opacity:0;pointer-events:none}.wc-gallery{border-top:1px solid var(--rule);margin-top:20px;padding-top:18px}.wc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:9px}.wc-grid figure{margin:0;border:1px solid var(--rule);border-radius:4px;overflow:hidden;position:relative}.wc-grid img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}.wc-grid figcaption{font-size:10.5px;color:var(--dim);padding:6px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wc-empty{color:var(--dim);border:1px dashed var(--rule);padding:35px;text-align:center;border-radius:4px}.wc footer{max-width:1380px;color:var(--dim);font-size:11px;text-align:right}@media(max-width:800px){.wc{padding:18px 14px}.wc-head{align-items:flex-start;flex-direction:column}.wc-copy,.wc-slots{grid-template-columns:1fr}.wc-row{flex-direction:column}}
`;
