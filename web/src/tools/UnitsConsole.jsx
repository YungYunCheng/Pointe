import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const STATUS = {
  available: { label: "Available", color: "#0E8577" },
  signed: { label: "Signed · awaiting move-in", color: "#C98A15" },
  occupied: { label: "Occupied", color: "#78899A" },
  turnover: { label: "Turnover", color: "#B23A54" },
  offline: { label: "Offline", color: "#513B74" },
};
const money = (n) => n == null || n === "" ? "—" : new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD", maximumFractionDigits: 0,
}).format(Number(n));

export default function UnitsConsole({ session }) {
  const [units, setUnits] = useState([]);
  const [counts, setCounts] = useState({});
  const [building, setBuilding] = useState("370");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const canEdit = ["admin", "property_manager"].includes(session?.role);
  const load = async () => {
    setError("");
    try {
      const data = await api.units();
      setUnits(data.units ?? []); setCounts(data.counts ?? {});
      setSelected((current) => current
        ? (data.units ?? []).find((u) => u.unit_number === current.unit_number) ?? null
        : null);
    } catch (e) { setError(e.code || "UNITS_LOAD_FAILED"); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => units.filter((u) => u.building_code === building &&
    (filter === "all" || u.status === filter)), [units, building, filter]);
  const byFloor = useMemo(() => Object.fromEntries([6, 5, 4, 3, 2, 1]
    .map((floor) => [floor, shown.filter((u) => Number(u.floor) === floor)])), [shown]);
  const average = units.filter((u) => u.current_rent != null)
    .reduce((a, u, _, arr) => a + Number(u.current_rent) / arr.length, 0);

  return <section className="uc">
    <style>{CSS}</style>
    <header className="uc-head">
      <div><span>Baydo Pointe · Live unit register</span><h1>Units & rent</h1></div>
      <button onClick={load} disabled={loading}>Refresh</button>
    </header>

    <div className="uc-stats">
      <Stat label="Total units" value={units.length || 330} />
      <Stat label="Available" value={counts.available ?? 0} />
      <Stat label="Signed" value={counts.signed ?? 0} />
      <Stat label="Occupied" value={counts.occupied ?? 0} />
      <Stat label="Average rent" value={money(average)} />
    </div>

    <div className={`uc-access ${canEdit ? "edit" : "read"}`}>
      <strong>{canEdit ? "Edit access" : "Read-only access"}</strong>
      <span>{canEdit
        ? `${session?.role === "admin" ? "Admin" : "Property Manager"} can update rent, status, availability and notes.`
        : `${session?.role === "building_manager" ? "Building Manager" : "Accounting"} can see the same unit and rent information but cannot change it.`}</span>
    </div>

    {error && <div className="uc-error">Could not load units: {error}</div>}
    {loading ? <div className="uc-loading">Loading units…</div> : <>
      <div className="uc-controls">
        <div className="uc-buildings">
          {["370", "374", "378"].map((b) => <button key={b}
            className={building === b ? "on" : ""} onClick={() => setBuilding(b)}>
            <strong>{b}</strong><span>{units.filter((u) => u.building_code === b).length} units</span>
          </button>)}
        </div>
        <div className="uc-filters">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
          {Object.entries(STATUS).map(([key, st]) => <button key={key}
            className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
            <i style={{ background: st.color }} />{st.label}
          </button>)}
        </div>
      </div>

      <div className="uc-floors">
        {[6, 5, 4, 3, 2, 1].map((floor) => <div className="uc-floor" key={floor}>
          <div className="uc-floor-label">{floor}F</div>
          <div className="uc-grid">
            {!byFloor[floor].length && <span className="uc-empty">No matching units</span>}
            {byFloor[floor].map((u) => {
              const st = STATUS[u.status] ?? STATUS.offline;
              return <button className="uc-unit" key={u.id} style={{ "--status": st.color }}
                onClick={() => setSelected(u)}>
                <span className="uc-no">{u.unit_number.split("-").pop()}</span>
                <span>{u.unit_type_code}</span>
                <strong>{money(u.current_rent)}</strong>
                <i title={st.label} />
              </button>;
            })}
          </div>
        </div>)}
      </div>
    </>}

    {selected && <UnitDrawer unit={selected} canEdit={canEdit}
      onClose={() => setSelected(null)} onSaved={load} />}
  </section>;
}

function Stat({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function UnitDrawer({ unit, canEdit, onClose, onSaved }) {
  const [form, setForm] = useState({
    status: unit.status,
    rent_override: unit.rent_override ?? "",
    available_from: unit.available_from?.slice?.(0, 10) ?? "",
    notes: unit.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try {
      await api.setStatus(unit.unit_number, form);
      await onSaved(); onClose();
    } catch (e) { setError(e.code || "SAVE_FAILED"); setBusy(false); }
  };
  return <div className="uc-mask" onClick={onClose}>
    <aside className="uc-drawer" onClick={(e) => e.stopPropagation()}>
      <header><div><span>Building {unit.building_code} · Floor {unit.floor}</span>
        <h2>{unit.unit_number}</h2><p>{unit.unit_type_code} · {unit.bedroom_label_en} · {unit.area_sqft} ft²</p></div>
        <button onClick={onClose} aria-label="Close">×</button></header>
      {!canEdit && <div className="uc-lock">Read only — only Admin and Property Manager can edit units.</div>}
      <label><span>Current rent</span>
        <div className="uc-money"><b>$</b><input type="number" step="1" value={form.rent_override}
          disabled={!canEdit} placeholder={String(unit.current_rent ?? "")}
          onChange={(e) => setForm({ ...form, rent_override: e.target.value })} /></div>
        <small>{form.rent_override === "" ? `Using floor-plan price: ${money(unit.current_rent)}` : "Unit-specific rent override"}</small>
      </label>
      <label><span>Status</span><select value={form.status} disabled={!canEdit}
        onChange={(e) => setForm({ ...form, status: e.target.value })}>
        {Object.entries(STATUS).map(([key, st]) => <option key={key} value={key}>{st.label}</option>)}
      </select></label>
      <label><span>Available from</span><input type="date" value={form.available_from}
        disabled={!canEdit} onChange={(e) => setForm({ ...form, available_from: e.target.value })} /></label>
      <label><span>Notes</span><textarea rows="4" value={form.notes} disabled={!canEdit}
        onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      {error && <div className="uc-error">Save failed: {error}</div>}
      <footer>{canEdit && <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>}
        <button onClick={onClose}>{canEdit ? "Cancel" : "Close"}</button></footer>
    </aside>
  </div>;
}

const CSS = `
.uc{padding:26px;max-width:1500px;margin:auto;color:#17212b;font-size:14px}.uc *{box-sizing:border-box}
.uc button,.uc input,.uc select,.uc textarea{font:inherit}.uc-head{display:flex;justify-content:space-between;align-items:center;gap:16px}
.uc-head span{font-size:12px;color:#718096;text-transform:uppercase;letter-spacing:.06em}.uc h1{font-size:28px;margin:3px 0 0}
.uc-head button,.uc-drawer button{border:1px solid #cbd5df;background:#fff;border-radius:5px;padding:8px 13px;cursor:pointer}
.uc-stats{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));border:1px solid #d7dee5;background:#fff;margin:20px 0}
.uc-stats div{padding:14px 16px;border-right:1px solid #e2e7eb}.uc-stats div:last-child{border:0}.uc-stats span{display:block;color:#718096;font-size:11px}.uc-stats strong{display:block;font-size:21px;margin-top:4px}
.uc-access{display:flex;gap:10px;align-items:center;padding:10px 13px;border-left:4px solid;margin-bottom:16px}.uc-access.edit{background:#edf8f5;border-color:#0E8577}.uc-access.read{background:#f5f7f9;border-color:#718096}.uc-access span{color:#526170}
.uc-controls{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;margin:18px 0}.uc-buildings,.uc-filters{display:flex;gap:6px;flex-wrap:wrap}.uc-buildings button{border:1px solid #cbd5df;background:#fff;padding:9px 16px;min-width:100px;text-align:left;cursor:pointer}.uc-buildings button.on{background:#17212b;color:#fff;border-color:#17212b}.uc-buildings strong,.uc-buildings span{display:block}.uc-buildings span{font-size:11px;opacity:.7}.uc-filters button{border:0;background:transparent;color:#5c6b79;padding:7px;cursor:pointer}.uc-filters button.on{font-weight:700;color:#17212b}.uc-filters i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.uc-floors{border:1px solid #d7dee5;background:#fff}.uc-floor{display:grid;grid-template-columns:48px 1fr;border-bottom:1px solid #e5e9ed;min-height:74px}.uc-floor:last-child{border:0}.uc-floor-label{display:grid;place-items:center;background:#f4f6f8;color:#718096;font-weight:700}.uc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:1px;background:#e5e9ed}.uc-unit{position:relative;border:0;background:#fff;padding:10px;text-align:left;min-height:72px;cursor:pointer}.uc-unit:hover{background:#f3f8fb}.uc-unit span{display:block;font-size:11px;color:#718096}.uc-unit .uc-no{font-size:15px;color:#17212b;font-weight:700}.uc-unit strong{display:block;margin-top:4px}.uc-unit>i{position:absolute;right:8px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--status)}.uc-empty{padding:24px;color:#98a4af;background:#fff}
.uc-error{padding:11px 13px;background:#fff0f2;color:#9f2741;border:1px solid #f0c3cd;margin:12px 0}.uc-loading{padding:50px;text-align:center;color:#718096}
.uc-mask{position:fixed;inset:0;background:#11182766;z-index:80;display:flex;justify-content:flex-end}.uc-drawer{width:min(460px,100%);height:100%;overflow:auto;background:#fff;padding:24px;box-shadow:-10px 0 30px #11182722}.uc-drawer header{display:flex;justify-content:space-between;gap:14px;border-bottom:1px solid #e1e6ea;padding-bottom:15px}.uc-drawer header span,.uc-drawer header p{font-size:12px;color:#718096}.uc-drawer h2{margin:4px 0}.uc-drawer header p{margin:0}.uc-drawer header button{border:0;font-size:24px;padding:0 5px}.uc-drawer label{display:block;margin-top:18px}.uc-drawer label>span{display:block;font-weight:600;margin-bottom:6px}.uc-drawer input,.uc-drawer select,.uc-drawer textarea{width:100%;border:1px solid #cbd5df;border-radius:4px;padding:10px;background:#fff}.uc-drawer :disabled{background:#f4f6f8;color:#647181}.uc-money{display:flex;border:1px solid #cbd5df;border-radius:4px;align-items:center}.uc-money b{padding-left:10px}.uc-money input{border:0}.uc-drawer small{display:block;color:#718096;margin-top:5px}.uc-lock{background:#f4f6f8;padding:11px;margin-top:16px}.uc-drawer footer{display:flex;gap:8px;margin-top:24px}.uc-drawer button.primary{background:#173b5f;color:#fff;border-color:#173b5f}
@media(max-width:760px){.uc{padding:16px}.uc-stats{grid-template-columns:repeat(2,1fr)}.uc-stats div{border-bottom:1px solid #e2e7eb}.uc-floor{grid-template-columns:38px 1fr}.uc-grid{grid-template-columns:repeat(2,1fr)}}`;
