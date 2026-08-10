import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

export default function FloorPlans({ session }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const canEdit = ["admin", "property_manager"].includes(session?.role);
  const load = async () => {
    try { setRows((await api.get("/unit-types")).unit_types ?? []); setError(""); }
    catch (e) { setError(e.code || "LOAD_FAILED"); }
  };
  useEffect(() => { load(); }, []);
  return <section className="fp"><style>{CSS}</style>
    <header><div><span>Leasing content</span><h1>Floor plans & virtual tours</h1></div></header>
    <p className="fp-note">Paste the HTTPS link supplied by Matterport, CloudPano or another tour host. The private company-server key is ready for the later storage connection and is never shown on the public rental site.</p>
    {!canEdit && <div className="fp-read">Read only — Admin and Property Manager manage tour links.</div>}
    {error && <div className="fp-error">{error}</div>}
    <div className="fp-grid">{rows.map((r) => <article key={r.code}>
      <div className="fp-cardh"><strong>{r.code}</strong><span>{r.bedroom_label_en}</span></div>
      <dl><div><dt>Interior</dt><dd>{r.area_sqft} ft²</dd></div><div><dt>Balcony</dt><dd>{r.balcony_sqft} ft²</dd></div></dl>
      <div className={`fp-status ${r.virtual_tour_url ? "live" : "empty"}`}>
        {r.virtual_tour_url ? <>Virtual tour live · {r.virtual_tour_provider || "Hosted link"}</> : "No virtual tour yet"}
      </div>
      <div className="fp-actions">{r.virtual_tour_url && <a href={r.virtual_tour_url} target="_blank" rel="noreferrer">Open tour</a>}
        {canEdit && <button onClick={() => setEditing(r)}>{r.virtual_tour_url ? "Edit" : "Add tour"}</button>}</div>
    </article>)}</div>
    {editing && <Editor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </section>;
}

function Editor({ row, onClose, onSaved }) {
  const [form, setForm] = useState({ virtual_tour_url: row.virtual_tour_url ?? "",
    virtual_tour_provider: row.virtual_tour_provider ?? "Matterport",
    virtual_tour_storage_key: row.virtual_tour_storage_key ?? "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const save = async () => { setBusy(true); setError(""); try {
    await api.patch(`/unit-types/${encodeURIComponent(row.code)}/virtual-tour`, form); onSaved();
  } catch (e) { setError(e.code || "SAVE_FAILED"); setBusy(false); } };
  return <div className="fp-mask" onClick={onClose}><aside onClick={(e) => e.stopPropagation()}>
    <header><div><span>Floor plan</span><h2>{row.code}</h2></div><button onClick={onClose}>×</button></header>
    <label><span>Tour provider</span><select value={form.virtual_tour_provider} onChange={(e) => setForm({ ...form, virtual_tour_provider: e.target.value })}>
      {["Matterport", "CloudPano", "Kuula", "Other"].map((x) => <option key={x}>{x}</option>)}</select></label>
    <label><span>Public virtual-tour URL</span><input type="url" placeholder="https://..." value={form.virtual_tour_url}
      onChange={(e) => setForm({ ...form, virtual_tour_url: e.target.value })} /><small>Only HTTPS links are accepted.</small></label>
    <label><span>Company-server storage key (later)</span><input placeholder="tours/1A/index.html" value={form.virtual_tour_storage_key}
      onChange={(e) => setForm({ ...form, virtual_tour_storage_key: e.target.value })} /><small>This does not claim the file was uploaded. It becomes active after the company-server connector is added.</small></label>
    {error && <div className="fp-error">{error}</div>}<footer><button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save virtual tour"}</button><button onClick={onClose}>Cancel</button></footer>
  </aside></div>;
}

const CSS = `.fp{padding:28px;max-width:1300px;margin:auto;color:#17212b}.fp *{box-sizing:border-box}.fp>header span{font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:.08em}.fp h1{margin:4px 0 16px}.fp-note{max-width:82ch;color:#5f6e7b;line-height:1.6}.fp-read,.fp-error{padding:11px 13px;margin:14px 0}.fp-read{background:#f2f5f7}.fp-error{background:#fff0f2;color:#9f2741}.fp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:22px}.fp article{background:#fff;border:1px solid #d7dee5;padding:16px}.fp-cardh{display:flex;justify-content:space-between}.fp-cardh strong{font-size:20px}.fp-cardh span{color:#718096}.fp dl{display:flex;gap:22px}.fp dl div{display:flex;gap:6px}.fp dt{color:#718096}.fp dd{margin:0;font-weight:600}.fp-status{padding:9px;margin:14px 0;font-size:12px}.fp-status.live{background:#edf8f5;color:#087365}.fp-status.empty{background:#f3f5f7;color:#718096}.fp-actions{display:flex;justify-content:flex-end;gap:8px}.fp button,.fp a{font:inherit;border:1px solid #bfcad3;background:#fff;color:#173b5f;padding:8px 12px;border-radius:4px;text-decoration:none;cursor:pointer}.fp-mask{position:fixed;inset:0;background:#11182766;z-index:80;display:flex;justify-content:flex-end}.fp-mask aside{width:min(480px,100%);background:#fff;height:100%;padding:24px}.fp-mask header{display:flex;justify-content:space-between}.fp-mask h2{margin:2px 0}.fp-mask header span,.fp-mask small{color:#718096;font-size:12px}.fp-mask header button{border:0;font-size:24px}.fp-mask label{display:block;margin-top:19px}.fp-mask label>span{display:block;font-weight:600;margin-bottom:6px}.fp-mask input,.fp-mask select{width:100%;padding:10px;border:1px solid #c5cfd7;border-radius:4px}.fp-mask small{display:block;margin-top:5px;line-height:1.5}.fp-mask footer{display:flex;gap:8px;margin-top:24px}.fp-mask button.primary{background:#173b5f;color:#fff;border-color:#173b5f}`;
