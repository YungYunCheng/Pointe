import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const STATUS = {
  available: { label: "Available", color: "#0E8577" },
  signed: { label: "Signed · awaiting move-in", color: "#C98A15" },
  occupied: { label: "Occupied", color: "#78899A" },
  turnover: { label: "Turnover", color: "#B23A54" },
  offline: { label: "Offline", color: "#513B74" },
};
const RENT_STATUS = {
  paid: { color: "#0E8577" }, prepaid: { color: "#0E8577" },
  partial: { color: "#C98A15" }, outstanding: { color: "#B23A54" },
  awaiting_move_in: { color: "#718096" }, not_billed: { color: "#1C6FA6" },
  vacant: { color: "#98A4AF" },
};
const money = (n) => n == null || n === "" ? "—" : new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD", maximumFractionDigits: 0,
}).format(Number(n));
const money2 = (n) => n == null || n === "" ? "—" : new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(n));

export default function UnitsConsole({ session }) {
  const [units, setUnits] = useState([]);
  const [counts, setCounts] = useState({});
  const [building, setBuilding] = useState("370");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return units.filter((u) => u.building_code === building &&
      (filter === "all" || u.status === filter) && (!q || [u.unit_number,
        u.resident?.full_name, u.resident?.email, u.resident?.phone]
        .some((value) => String(value ?? "").toLowerCase().includes(q))));
  }, [units, building, filter, query]);
  const byFloor = useMemo(() => Object.fromEntries([6, 5, 4, 3, 2, 1]
    .map((floor) => [floor, shown.filter((u) => Number(u.floor) === floor)])), [shown]);
  const average = units.filter((u) => u.current_rent != null)
    .reduce((a, u, _, arr) => a + Number(u.current_rent) / arr.length, 0);
  const billed = units.filter((u) => Number(u.rent_status?.current_rent_due) > 0);
  const paidThisMonth = billed.filter((u) => u.rent_status?.is_paid).length;

  if (selected) return <UnitWorkspace unit={selected} session={session}
    canEditUnit={canEdit} onBack={() => setSelected(null)} onSaved={load} />;

  return <section className="uc">
    <style>{CSS}</style>
    <header className="uc-head">
      <div><span>Baydo Pointe · Live unit register</span><h1>Units & residents</h1></div>
      <button onClick={load} disabled={loading}>Refresh</button>
    </header>

    <div className="uc-stats">
      <Stat label="Total units" value={units.length || 330} />
      <Stat label="Available" value={counts.available ?? 0} />
      <Stat label="Signed" value={counts.signed ?? 0} />
      <Stat label="Occupied" value={counts.occupied ?? 0} />
      <Stat label="Average rent" value={money(average)} />
      <Stat label="Rent paid this month" value={`${paidThisMonth} / ${billed.length}`} />
    </div>

    <div className={`uc-access ${canEdit ? "edit" : "read"}`}>
      <strong>{canEdit ? "Edit access" : "Read-only access"}</strong>
      <span>{canEdit
        ? `${session?.role === "admin" ? "Admin" : "Property Manager"} can manage unit status, rent and resident assignments.`
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
          <input className="uc-search" value={query} placeholder="Search unit or resident"
            onChange={(e) => setQuery(e.target.value)} />
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
                <RentBadge status={u.rent_status} compact />
                {u.resident?.full_name && <span className="uc-tenant" title={u.resident.full_name}>
                  {u.resident.full_name}
                </span>}
                <i title={st.label} />
              </button>;
            })}
          </div>
        </div>)}
      </div>
    </>}
  </section>;
}

function Stat({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function RentBadge({ status, compact = false }) {
  if (!status) return null;
  const color = RENT_STATUS[status.code]?.color ?? "#718096";
  const amount = status.prepayment > 0
    ? `Credit ${money2(status.prepayment)}`
    : status.outstanding_balance > 0
      ? `Balance ${money2(status.outstanding_balance)}` : "";
  return <span className={`uc-rent-badge ${compact ? "compact" : ""}`}
    style={{ "--rent-color": color }} title={[status.label, amount].filter(Boolean).join(" · ")}>
    <i />{status.label}{!compact && amount && <small>{amount}</small>}
  </span>;
}

function UnitWorkspace({ unit, session, canEditUnit, onBack, onSaved }) {
  const [tab, setTab] = useState("overview");
  const [form, setForm] = useState({
    status: unit.status,
    rent_override: unit.rent_override ?? "",
    available_from: unit.available_from?.slice?.(0, 10) ?? "",
    notes: unit.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [residentMode, setResidentMode] = useState("view");
  const canSeeDocuments = ["admin", "property_manager"].includes(session?.role);
  const tabs = [
    ["overview", "Overview"], ["tenant", "Tenant information"], ["ledger", "Ledger"],
    ...(canSeeDocuments ? [["documents", "Tenant documents"]] : []),
  ];
  useEffect(() => {
    setForm({
      status: unit.status,
      rent_override: unit.rent_override ?? "",
      available_from: unit.available_from?.slice?.(0, 10) ?? "",
      notes: unit.notes ?? "",
    });
  }, [unit.unit_number, unit.status, unit.rent_override, unit.available_from, unit.notes]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      await api.setStatus(unit.unit_number, form);
      await onSaved(); setBusy(false);
    } catch (e) { setError(e.code || "SAVE_FAILED"); setBusy(false); }
  };
  return <section className="uc uc-profile">
    <style>{CSS}</style>
    <button className="uc-back" onClick={onBack}>← Back to all units</button>
    <header className="uc-profile-head">
      <div><span>Building {unit.building_code} · Floor {unit.floor}</span>
        <h1>{unit.unit_number}</h1>
        <p>{unit.unit_type_code} · {unit.bedroom_label_en} · {unit.area_sqft} ft²</p></div>
      <div className="uc-profile-status"><i style={{ background: STATUS[unit.status]?.color }} />
        <strong>{STATUS[unit.status]?.label || unit.status}</strong>
        <span>{unit.resident?.full_name || "No active resident"}</span>
        <RentBadge status={unit.rent_status} />
      </div>
    </header>

    <nav className="uc-tabs">{tabs.map(([key, label]) => <button key={key}
      className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>

    {tab === "overview" && <div className="uc-profile-grid">
      <section className="uc-panel">
        <div className="uc-panel-head"><div><span className="uc-kicker">Resident account</span>
          <h2>{unit.resident?.full_name || "No resident assigned"}</h2></div>
          {unit.resident?.lease_id && <button onClick={() => setTab("tenant")}>Open profile</button>}</div>
        {unit.resident?.lease_id ? <>
          <div className="uc-rent-summary">
            <RentBadge status={unit.rent_status} />
            <span>{unit.rent_status?.period || "Current month"}</span>
          </div>
          <div className="uc-summary-grid">
            <Info label="Email" value={unit.resident.email || "—"} />
            <Info label="Phone" value={unit.resident.phone || "—"} />
            <Info label="Monthly rent" value={money2(unit.resident.rent)} />
            <Info label="Lease ends" value={unit.resident.end_date?.slice?.(0, 10) || "Periodic"} />
          </div>
          <button className="uc-ledger-link" onClick={() => setTab("ledger")}>View tenant ledger →</button>
        </> : <div className="uc-resident-empty">No active lease or tenant is linked to this unit.</div>}
      </section>

      <section className="uc-panel uc-unit-settings">
        <div className="uc-panel-head"><div><span className="uc-kicker">Unit record</span><h2>Rent & availability</h2></div></div>
        {!canEditUnit && <div className="uc-lock">Read only — only Admin and Property Manager can edit unit details.</div>}
        <div className="uc-form-grid">
          <label><span>Listing rent override</span><div className="uc-money"><b>$</b><input type="number" step="1"
            value={form.rent_override} disabled={!canEditUnit} placeholder={String(unit.market_rent ?? "")}
            onChange={(e) => setForm({ ...form, rent_override: e.target.value })} /></div>
            <small>{form.rent_override === "" ? `Floor-plan price: ${money(unit.market_rent)}` : "Unit-specific override"}</small></label>
          <label><span>Status</span><select value={form.status} disabled={!canEditUnit}
            onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(STATUS).map(([key, st]) => <option key={key} value={key}>{st.label}</option>)}</select></label>
          <label><span>Available from</span><input type="date" value={form.available_from}
            disabled={!canEditUnit} onChange={(e) => setForm({ ...form, available_from: e.target.value })} /></label>
          <label className="wide"><span>Notes</span><textarea rows="4" value={form.notes} disabled={!canEditUnit}
            onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        {error && <div className="uc-error">Save failed: {error}</div>}
        {canEditUnit && <button className="uc-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save unit changes"}</button>}
      </section>
    </div>}

    {tab === "tenant" && <section className="uc-panel uc-tenant-page">
      <ResidentCard resident={unit.resident} parking={unit.parking ?? []}
        canEdit={canEditUnit} unit={unit} mode={residentMode} setMode={setResidentMode}
        onSaved={onSaved} />
    </section>}

    {tab === "ledger" && <UnitLedger unit={unit} session={session} onUnitSaved={onSaved} />}

    {tab === "documents" && canSeeDocuments && <section className="uc-panel uc-doc-note">
      <span className="uc-kicker">Tenant documents</span><h2>Lease and signed documents</h2>
      <p>Official agreement templates, issued copies and signature status are managed in Agreements. This keeps the company template library separate from this tenant account.</p>
      <a className="uc-primary" href="/agreements">Open Agreements</a>
    </section>}
  </section>;
}

function UnitLedger({ unit, session, onUnitSaved }) {
  const canEdit = ["admin", "accounting"].includes(session?.role);
  const [data, setData] = useState(null);
  const [methods, setMethods] = useState([]);
  const [mode, setMode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setError("");
    try { setData(await api.unitLedger(unit.unit_number)); }
    catch (e) { setError(e.code || "LEDGER_LOAD_FAILED"); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [unit.unit_number]);
  useEffect(() => {
    if (canEdit) api.manualPaymentMethods().then((x) => setMethods(x.methods ?? [])).catch(() => {});
  }, [canEdit]);

  const voidCharge = async (row) => {
    const reason = window.prompt("Reason for voiding this charge:");
    if (!reason?.trim()) return;
    try { await api.voidLedgerCharge(unit.unit_number, row.id, reason.trim()); await load(); }
    catch (e) { setError(e.payload?.detail || e.code || "VOID_FAILED"); }
  };
  const reversePayment = async (row) => {
    const reason = window.prompt("Reason for reversing this payment:");
    if (!reason?.trim()) return;
    try { await api.reversePayment(row.id, reason.trim()); await load(); }
    catch (e) { setError(e.payload?.detail || e.code || "REVERSAL_FAILED"); }
  };

  if (loading) return <div className="uc-loading">Loading tenant ledger…</div>;
  return <section className="uc-ledger">
    <div className={`uc-access ${canEdit ? "edit" : "read"}`}>
      <strong>{canEdit ? "Accounting access" : "Read-only ledger"}</strong>
      <span>{canEdit ? "Admin and Accounting can post adjustments, record payments and reverse entries."
        : "Property Manager and Building Manager can view every transaction but cannot change the ledger."}</span>
    </div>
    {error && <div className="uc-error">{error}</div>}
    {notice && <div className="uc-success">{notice}</div>}
    {data && <>
      <div className="uc-ledger-stats">
        <Stat label="Outstanding balance" value={money2(data.summary.outstanding)} />
        <Stat label="Prepayment credit" value={money2(data.summary.prepayment)} />
        <Stat label="Overdue" value={money2(data.summary.overdue)} />
        <Stat label="Total charges" value={money2(data.summary.total_debits)} />
        <Stat label="Total payments" value={money2(data.summary.total_credits)} />
        <Stat label="Deposit held" value={money2(data.summary.deposit_held)} />
      </div>
      <div className="uc-ledger-toolbar"><div><h2>Tenant ledger</h2><p>Charges, payments, credits and reversals for {unit.unit_number}</p></div>
        {canEdit && <div><button onClick={() => setMode(mode === "charge" ? null : "charge")}>Add charge / credit</button>
          <button className="uc-primary" onClick={() => setMode(mode === "payment" ? null : "payment")}>Record payment</button></div>}</div>
      {canEdit && mode && <LedgerEntryForm mode={mode} unit={unit} methods={methods}
        onCancel={() => setMode(null)} onSaved={async (result) => {
          setMode(null);
          if (result?.account?.prepayment > 0) setNotice(`Payment recorded. Prepayment credit: ${money2(result.account.prepayment)}.`);
          else if (result?.account?.outstanding > 0) setNotice(`Payment recorded. Outstanding balance: ${money2(result.account.outstanding)}.`);
          else if (result?.payment) setNotice("Payment recorded. The tenant balance is paid in full.");
          else setNotice("Ledger entry posted.");
          await load(); await onUnitSaved?.();
        }} />}
      <div className="uc-ledger-table"><table><thead><tr><th>Date</th><th>Description</th><th>Status</th>
        <th className="num">Charge</th><th className="num">Payment / credit</th><th className="num">Balance</th>{canEdit && <th />}</tr></thead>
        <tbody>{!data.transactions.length && <tr><td colSpan={canEdit ? 7 : 6} className="uc-no-ledger">No ledger transactions yet.</td></tr>}
          {data.transactions.map((row) => <tr key={`${row.source}-${row.id}`}>
            <td>{String(row.date).slice(0, 10)}</td><td><strong>{row.description}</strong><span>{row.kind}</span></td>
            <td><span className={`uc-ledger-state ${row.state}`}>{row.state}</span></td>
            <td className="num">{row.debit ? money2(row.debit) : "—"}</td>
            <td className="num">{row.credit ? money2(row.credit) : row.source === "payment" ? `${money2(row.amount)} (${row.state})` : "—"}</td>
            <td className="num"><strong>{money2(row.balance)}</strong></td>
            {canEdit && <td className="actions">{row.source === "charge"
              ? <button onClick={() => voidCharge(row)}>Void</button>
              : ["authorised", "settled"].includes(row.state) && <button onClick={() => reversePayment(row)}>Reverse</button>}</td>}
          </tr>)}</tbody></table></div>
      {!!data.deposits?.length && <section className="uc-deposits"><h3>Security deposit movements</h3>
        {data.deposits.map((x) => <div key={x.id}><span>{x.txn_date} · {x.kind}{x.basis ? ` · ${x.basis}` : ""}</span><strong>{money2(x.amount)}</strong></div>)}</section>}
    </>}
  </section>;
}

function LedgerEntryForm({ mode, unit, methods, onCancel, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState(mode === "payment" ? {
    amount: "", method_code: methods[0]?.code || "etransfer", purpose: "rent",
    received_on: today, reference: "", cheque_number: "", bank_name: "", note: "",
  } : { direction: "debit", kind: "other", amount: "", date: today,
    due_date: today, description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((x) => ({ ...x, ...patch }));
  const save = async () => {
    if (!(Number(form.amount) > 0) || busy) return;
    setBusy(true); setError("");
    try {
      const result = mode === "payment"
        ? await api.manualPayment({ ...form, unit_number: unit.unit_number })
        : await api.addLedgerCharge(unit.unit_number, form);
      await onSaved(result);
    } catch (e) { setError(e.payload?.detail || e.code || "LEDGER_SAVE_FAILED"); setBusy(false); }
  };
  return <section className="uc-entry-form"><h3>{mode === "payment" ? "Record a payment received" : "Add a ledger charge or credit"}</h3>
    <div className="uc-form-grid">{mode === "payment" ? <>
      <label><span>Payment method</span><select value={form.method_code} onChange={(e) => set({ method_code: e.target.value, cheque_number: "", bank_name: "" })}>
        {methods.map((m) => <option key={m.code} value={m.code}>{m.label_en}</option>)}</select></label>
      <label><span>Purpose</span><select value={form.purpose} onChange={(e) => set({ purpose: e.target.value })}>
        <option value="rent">Rent / tenant balance</option><option value="deposit">Security deposit</option><option value="other">Other</option></select></label>
      <label><span>Amount</span><input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
      <label><span>Received date</span><input type="date" value={form.received_on} onChange={(e) => set({ received_on: e.target.value })} /></label>
      {form.method_code === "cheque" ? <>
        <label><span>Cheque number</span><input value={form.cheque_number}
          onChange={(e) => set({ cheque_number: e.target.value })} required /></label>
        <label><span>Bank name <em>optional</em></span><input value={form.bank_name}
          onChange={(e) => set({ bank_name: e.target.value })} /></label>
      </> : <label><span>Reference <em>optional</em></span><input value={form.reference}
        onChange={(e) => set({ reference: e.target.value })} /></label>}
      <label><span>Note</span><input value={form.note} onChange={(e) => set({ note: e.target.value })} /></label>
      {form.purpose !== "deposit" && <PaymentPreview amount={form.amount} status={unit.rent_status} />}
    </> : <>
      <label><span>Entry type</span><select value={form.direction} onChange={(e) => set({ direction: e.target.value })}>
        <option value="debit">Charge (increases balance)</option><option value="credit">Credit adjustment (reduces balance)</option></select></label>
      <label><span>Category</span><select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
        <option value="rent">Rent</option><option value="parking">Parking</option><option value="storage">Storage</option>
        <option value="pet">Pet</option><option value="late_fee">Late fee</option><option value="damage">Damage</option>
        <option value="utilities">Utilities</option><option value="adjustment">Adjustment</option><option value="other">Other</option></select></label>
      <label><span>Amount</span><input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
      <label><span>Transaction date</span><input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} /></label>
      <label><span>Due date</span><input type="date" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} /></label>
      <label className="wide"><span>Description</span><input value={form.description} onChange={(e) => set({ description: e.target.value })} /></label>
    </>}</div>
    {error && <div className="uc-error">{error}</div>}
    <div className="uc-form-actions"><button className="uc-primary" disabled={busy || !(Number(form.amount) > 0) ||
      (mode === "payment" && form.method_code === "cheque" && !form.cheque_number.trim()) ||
      (mode === "charge" && !form.description.trim())} onClick={save}>{busy ? "Saving…" : "Post entry"}</button>
      <button onClick={onCancel} disabled={busy}>Cancel</button></div>
  </section>;
}

function PaymentPreview({ amount, status }) {
  const payment = Number(amount) || 0;
  const outstanding = Number(status?.outstanding_balance) || 0;
  const existingCredit = Number(status?.prepayment) || 0;
  const after = outstanding - existingCredit - payment;
  return <div className="uc-payment-preview wide">
    <div><span>Current outstanding</span><strong>{money2(outstanding)}</strong></div>
    <div><span>Existing prepayment</span><strong>{money2(existingCredit)}</strong></div>
    <div><span>{after > 0.005 ? "Outstanding after payment" : "Prepayment after payment"}</span>
      <strong>{money2(Math.abs(after))}</strong></div>
  </div>;
}

function ResidentCard({ resident, parking, canEdit, unit, mode, setMode, onSaved }) {
  const assigned = !!resident?.lease_id;
  if (mode !== "view") return <ResidentForm resident={resident} unit={unit}
    mode={mode} onCancel={() => setMode("view")}
    onSaved={async () => { await onSaved(); setMode("view"); }} />;

  return <section className="uc-resident">
    <div className="uc-resident-head">
      <div><span className="uc-kicker">Resident profile</span>
        <h3>{assigned ? resident.full_name || "Tenant name missing" : "No resident assigned"}</h3></div>
      {canEdit && <button onClick={() => setMode(assigned ? "edit" : "assign")}>
        {assigned ? "Edit resident" : "Assign resident"}
      </button>}
    </div>
    {!assigned ? <div className={unit.status === "occupied" || unit.status === "signed"
      ? "uc-data-warning" : "uc-resident-empty"}>
      {unit.status === "occupied" || unit.status === "signed"
        ? "This unit is marked occupied/signed, but it has no active lease and resident record."
        : "Available unit — no active lease or tenant is linked."}
    </div> : <>
      <div className="uc-contact">
        {resident.email ? <a href={`mailto:${resident.email}`}>{resident.email}</a> : <span>No email</span>}
        {resident.phone ? <a href={`tel:${resident.phone}`}>{resident.phone}</a> : <span>No phone</span>}
        <span className={`uc-portal ${resident.account_id ? "linked" : ""}`}>
          {resident.account_id ? "Resident Portal linked" : "Resident Portal not linked"}
        </span>
      </div>
      <div className="uc-resident-grid">
        <Info label="Lease starts" value={resident.start_date?.slice?.(0, 10) || "—"} />
        <Info label="Lease ends" value={resident.end_date?.slice?.(0, 10) || "Periodic"} />
        <Info label="Monthly rent" value={money(resident.rent)} />
        <Info label="Security deposit" value={money(resident.deposit)} />
        <Info label="Occupants" value={resident.occupants ?? "—"} />
        <Info label="Term" value={termLabel(resident.term_type)} />
      </div>
      <div className="uc-resident-extra">
        <div><strong>Parking</strong><span>{parking.length
          ? parking.map((p) => `${p.pool_code} · ${p.status}`).join(", ")
          : resident.wants_parking ? "Requested — no stall assigned" : "None on file"}</span></div>
        <div><strong>Pets</strong><span>{resident.pets || "None on file"}</span></div>
        <div><strong>Storage</strong><span>{resident.wants_storage ? "Requested" : "None on file"}</span></div>
      </div>
    </>}
  </section>;
}

function Info({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

const termLabel = (term) => ({ fixed_12: "12-month fixed", fixed_6: "6-month fixed",
  fixed: "Fixed term", periodic: "Periodic" }[term] || term || "—");

function suggestedEnd(start, term) {
  if (!start || term === "periodic") return "";
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + (term === "fixed_6" ? 6 : 12));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function ResidentForm({ resident, unit, mode, onCancel, onSaved }) {
  const editing = mode === "edit";
  const [form, setForm] = useState(editing ? {
    full_name: resident.full_name ?? "", email: resident.email ?? "",
    phone: resident.phone ?? "", occupants: resident.occupants ?? "",
  } : {
    full_name: "", email: "", phone: "", occupants: "1", start_date: "",
    end_date: "", term_type: "fixed_12", rent: unit.current_rent ?? "",
    deposit: unit.current_rent ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const valid = form.full_name.trim() && (editing ||
    (form.start_date && form.rent !== "" && form.deposit !== "" &&
      (form.term_type === "periodic" || form.end_date)));

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      if (editing) {
        await api.updateResident(resident.lease_id, {
          full_name: form.full_name.trim(), email: form.email.trim(),
          phone: form.phone.trim(), occupants: form.occupants,
        });
      } else {
        await api.createLease({
          unit_number: unit.unit_number,
          tenant: { full_name: form.full_name.trim(), email: form.email.trim(),
            phone: form.phone.trim(), locale: "en" },
          start_date: form.start_date,
          end_date: form.term_type === "periodic" ? null : form.end_date,
          term_type: form.term_type, rent: Number(form.rent), deposit: Number(form.deposit),
          occupants: form.occupants === "" ? null : Number(form.occupants),
          signed_on: new Date().toISOString().slice(0, 10),
        });
      }
      await onSaved();
    } catch (e) { setError(e.code || "RESIDENT_SAVE_FAILED"); setBusy(false); }
  };

  return <section className="uc-resident uc-resident-form">
    <div className="uc-resident-head"><div><span className="uc-kicker">Resident profile</span>
      <h3>{editing ? "Edit resident" : "Assign resident to this unit"}</h3></div></div>
    <div className="uc-form-grid">
      <label><span>Tenant name</span><input value={form.full_name}
        onChange={(e) => set({ full_name: e.target.value })} /></label>
      <label><span>Occupants</span><input type="number" min="1" value={form.occupants}
        onChange={(e) => set({ occupants: e.target.value })} /></label>
      <label><span>Email</span><input type="email" value={form.email}
        onChange={(e) => set({ email: e.target.value })} /></label>
      <label><span>Phone</span><input value={form.phone}
        onChange={(e) => set({ phone: e.target.value })} /></label>
      {!editing && <>
        <label><span>Term</span><select value={form.term_type} onChange={(e) => {
          const term_type = e.target.value;
          set({ term_type, end_date: suggestedEnd(form.start_date, term_type) });
        }}><option value="fixed_12">12-month fixed</option><option value="fixed_6">6-month fixed</option>
          <option value="periodic">Periodic</option></select></label>
        <label><span>Lease start</span><input type="date" value={form.start_date}
          onChange={(e) => set({ start_date: e.target.value,
            end_date: suggestedEnd(e.target.value, form.term_type) })} /></label>
        {form.term_type !== "periodic" && <label><span>Lease end</span><input type="date"
          value={form.end_date} onChange={(e) => set({ end_date: e.target.value })} /></label>}
        <label><span>Monthly rent</span><input type="number" min="0" step="0.01" value={form.rent}
          onChange={(e) => set({ rent: e.target.value })} /></label>
        <label><span>Security deposit</span><input type="number" min="0" step="0.01" value={form.deposit}
          onChange={(e) => set({ deposit: e.target.value })} /></label>
      </>}
    </div>
    {error && <div className="uc-error">Could not save resident: {error}</div>}
    <div className="uc-form-actions"><button className="primary" disabled={!valid || busy} onClick={save}>
      {busy ? "Saving…" : editing ? "Save resident" : "Assign resident"}</button>
      <button onClick={onCancel} disabled={busy}>Cancel</button></div>
  </section>;
}

const CSS = `
.uc{padding:26px;max-width:1500px;margin:auto;color:#17212b;font-size:14px}.uc *{box-sizing:border-box}
.uc button,.uc input,.uc select,.uc textarea{font:inherit}.uc-head{display:flex;justify-content:space-between;align-items:center;gap:16px}
.uc-head span{font-size:12px;color:#718096;text-transform:uppercase;letter-spacing:.06em}.uc h1{font-size:28px;margin:3px 0 0}
.uc-head button,.uc-drawer button{border:1px solid #cbd5df;background:#fff;border-radius:5px;padding:8px 13px;cursor:pointer}
.uc-stats{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));border:1px solid #d7dee5;background:#fff;margin:20px 0}
.uc-stats div{padding:14px 16px;border-right:1px solid #e2e7eb}.uc-stats div:last-child{border:0}.uc-stats span{display:block;color:#718096;font-size:11px}.uc-stats strong{display:block;font-size:21px;margin-top:4px}
.uc-access{display:flex;gap:10px;align-items:center;padding:10px 13px;border-left:4px solid;margin-bottom:16px}.uc-access.edit{background:#edf8f5;border-color:#0E8577}.uc-access.read{background:#f5f7f9;border-color:#718096}.uc-access span{color:#526170}
.uc-controls{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;margin:18px 0}.uc-buildings,.uc-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.uc-buildings button{border:1px solid #cbd5df;background:#fff;padding:9px 16px;min-width:100px;text-align:left;cursor:pointer}.uc-buildings button.on{background:#17212b;color:#fff;border-color:#17212b}.uc-buildings strong,.uc-buildings span{display:block}.uc-buildings span{font-size:11px;opacity:.7}.uc-filters button{border:0;background:transparent;color:#5c6b79;padding:7px;cursor:pointer}.uc-filters button.on{font-weight:700;color:#17212b}.uc-filters i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.uc-search{width:190px;border:1px solid #cbd5df;border-radius:4px;padding:8px 10px;background:#fff}
.uc-floors{border:1px solid #d7dee5;background:#fff}.uc-floor{display:grid;grid-template-columns:48px 1fr;border-bottom:1px solid #e5e9ed;min-height:74px}.uc-floor:last-child{border:0}.uc-floor-label{display:grid;place-items:center;background:#f4f6f8;color:#718096;font-weight:700}.uc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:1px;background:#e5e9ed}.uc-unit{position:relative;border:0;background:#fff;padding:10px;text-align:left;min-height:72px;cursor:pointer}.uc-unit:hover{background:#f3f8fb}.uc-unit span{display:block;font-size:11px;color:#718096}.uc-unit .uc-no{font-size:15px;color:#17212b;font-weight:700}.uc-unit strong{display:block;margin-top:4px}.uc-unit .uc-tenant{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#34495e;margin-top:3px}.uc-unit>i{position:absolute;right:8px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--status)}.uc-empty{padding:24px;color:#98a4af;background:#fff}
.uc-error{padding:11px 13px;background:#fff0f2;color:#9f2741;border:1px solid #f0c3cd;margin:12px 0}.uc-success{padding:11px 13px;background:#e7f5f2;color:#0b7064;border:1px solid #b9ddd6;margin:12px 0}.uc-loading{padding:50px;text-align:center;color:#718096}
.uc-mask{position:fixed;inset:0;background:#11182766;z-index:80;display:flex;justify-content:flex-end}.uc-drawer{width:min(560px,100%);height:100%;overflow:auto;background:#fff;padding:24px;box-shadow:-10px 0 30px #11182722}.uc-drawer header{display:flex;justify-content:space-between;gap:14px;border-bottom:1px solid #e1e6ea;padding-bottom:15px}.uc-drawer header span,.uc-drawer header p{font-size:12px;color:#718096}.uc-drawer h2{margin:4px 0}.uc-drawer header p{margin:0}.uc-drawer header button{border:0;font-size:24px;padding:0 5px}.uc-drawer label{display:block;margin-top:18px}.uc-drawer label>span{display:block;font-weight:600;margin-bottom:6px}.uc-drawer input,.uc-drawer select,.uc-drawer textarea{width:100%;border:1px solid #cbd5df;border-radius:4px;padding:10px;background:#fff}.uc-drawer :disabled{background:#f4f6f8;color:#647181}.uc-money{display:flex;border:1px solid #cbd5df;border-radius:4px;align-items:center}.uc-money b{padding-left:10px}.uc-money input{border:0}.uc-drawer small{display:block;color:#718096;margin-top:5px}.uc-lock{background:#f4f6f8;padding:11px;margin-top:16px}.uc-drawer footer{display:flex;gap:8px;margin-top:24px}.uc-drawer button.primary{background:#173b5f;color:#fff;border-color:#173b5f}.uc-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin:26px 0 0;padding-top:18px;border-top:1px solid #e1e6ea}.uc-resident{margin-top:18px;border:1px solid #d7dee5;background:#fbfcfd;padding:16px}.uc-resident-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.uc-resident h3{margin:3px 0 0;font-size:18px}.uc-kicker{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.08em}.uc-contact{display:flex;gap:8px 14px;flex-wrap:wrap;margin:13px 0;font-size:12px}.uc-contact a{color:#1c6fa6}.uc-portal{background:#eef1f4;color:#65717d;padding:3px 7px;border-radius:10px}.uc-portal.linked{background:#e7f5f2;color:#0b7064}.uc-resident-grid{display:grid;grid-template-columns:repeat(2,1fr);border:1px solid #e0e6eb;background:#fff}.uc-resident-grid div{padding:9px 10px;border-right:1px solid #e7ebef;border-bottom:1px solid #e7ebef}.uc-resident-grid span,.uc-resident-grid strong{display:block}.uc-resident-grid span{font-size:10px;color:#718096}.uc-resident-grid strong{margin-top:3px;font-size:12px}.uc-resident-extra{margin-top:12px;display:grid;gap:7px}.uc-resident-extra div{display:grid;grid-template-columns:65px 1fr;gap:8px}.uc-resident-extra strong,.uc-resident-extra span{font-size:12px}.uc-resident-extra span{color:#526170}.uc-resident-empty,.uc-data-warning{margin-top:13px;padding:11px;color:#65717d;background:#fff}.uc-data-warning{background:#fff7e6;color:#7c5610;border-left:3px solid #c98a15}.uc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.uc-form-grid label{margin-top:12px}.uc-form-actions{display:flex;gap:8px;margin-top:16px}.uc-resident-form button.primary{background:#173b5f;color:#fff;border-color:#173b5f}
.uc-profile{max-width:1380px}.uc-back{border:0;background:transparent;color:#1c6fa6;padding:0;margin:0 0 16px;cursor:pointer}.uc-profile-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;background:#fff;border:1px solid #d7dee5;border-left:5px solid #173b5f;padding:22px 24px}.uc-profile-head>div>span,.uc-profile-head p{font-size:12px;color:#718096}.uc-profile-head h1{margin:3px 0}.uc-profile-head p{margin:0}.uc-profile-status{display:grid;grid-template-columns:10px auto;align-items:center;gap:4px 8px;text-align:right}.uc-profile-status i{width:9px;height:9px;border-radius:50%}.uc-profile-status span{grid-column:1/-1;color:#526170}.uc-tabs{display:flex;border-bottom:1px solid #cfd8df;margin:20px 0}.uc-tabs button{border:0;border-bottom:3px solid transparent;background:transparent;padding:11px 16px;color:#617180;cursor:pointer}.uc-tabs button.on{border-bottom-color:#173b5f;color:#173b5f;font-weight:700}.uc-profile-grid{display:grid;grid-template-columns:minmax(320px,.8fr) minmax(480px,1.2fr);gap:18px}.uc-panel{background:#fff;border:1px solid #d7dee5;padding:20px}.uc-panel h2{margin:3px 0 0;font-size:20px}.uc-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.uc-panel-head button,.uc-ledger-toolbar button,.uc-entry-form button,.uc-ledger-table button,.uc-resident-head button,.uc-form-actions button{font:inherit;border:1px solid #cbd5df;background:#fff;border-radius:4px;padding:8px 12px;cursor:pointer}.uc-summary-grid{display:grid;grid-template-columns:1fr 1fr;margin-top:18px;border:1px solid #e0e6eb}.uc-summary-grid>div{padding:12px;border-right:1px solid #e7ebef;border-bottom:1px solid #e7ebef}.uc-summary-grid span,.uc-summary-grid strong{display:block}.uc-summary-grid span{font-size:11px;color:#718096}.uc-summary-grid strong{margin-top:4px}.uc-ledger-link{margin-top:15px;border:0;background:transparent;color:#1c6fa6;padding:0;cursor:pointer}.uc-unit-settings label,.uc-entry-form label{display:block}.uc-unit-settings label>span,.uc-entry-form label>span{display:block;font-weight:600;margin-bottom:6px}.uc-unit-settings input,.uc-unit-settings select,.uc-unit-settings textarea,.uc-entry-form input,.uc-entry-form select{width:100%;font:inherit;border:1px solid #cbd5df;border-radius:4px;padding:10px;background:#fff}.uc-unit-settings :disabled{background:#f4f6f8;color:#647181}.uc-form-grid .wide{grid-column:1/-1}.uc-unit-settings small{display:block;color:#718096;margin-top:5px}.uc-primary{display:inline-block;background:#173b5f!important;color:#fff!important;border:1px solid #173b5f!important;border-radius:4px;padding:9px 14px;text-decoration:none;cursor:pointer}.uc-unit-settings>.uc-primary{margin-top:16px}.uc-tenant-page .uc-resident{margin:0;border:0;padding:0;background:#fff}.uc-doc-note{max-width:780px}.uc-doc-note p{color:#526170;line-height:1.65;max-width:680px}.uc-ledger-stats{display:grid;grid-template-columns:repeat(6,1fr);background:#fff;border:1px solid #d7dee5;margin:16px 0}.uc-ledger-stats>div{padding:15px;border-right:1px solid #e2e7eb}.uc-ledger-stats>div:last-child{border:0}.uc-ledger-stats span,.uc-ledger-stats strong{display:block}.uc-ledger-stats span{font-size:11px;color:#718096}.uc-ledger-stats strong{font-size:18px;margin-top:4px}.uc-ledger-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:24px 0 12px}.uc-ledger-toolbar h2{margin:0}.uc-ledger-toolbar p{margin:4px 0 0;color:#718096}.uc-ledger-toolbar>div:last-child{display:flex;gap:8px}.uc-entry-form{background:#f7f9fb;border:1px solid #d7dee5;border-left:4px solid #1c6fa6;padding:18px;margin:12px 0}.uc-entry-form h3{margin:0 0 8px}.uc-ledger-table{overflow:auto;background:#fff;border:1px solid #d7dee5}.uc-ledger-table table{width:100%;border-collapse:collapse;min-width:930px}.uc-ledger-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#718096;background:#f4f6f8;text-align:left}.uc-ledger-table th,.uc-ledger-table td{padding:11px 12px;border-bottom:1px solid #e5e9ed;vertical-align:top}.uc-ledger-table td>strong,.uc-ledger-table td>span{display:block}.uc-ledger-table td>span{font-size:11px;color:#718096;margin-top:3px}.uc-ledger-table .num{text-align:right;white-space:nowrap}.uc-ledger-table .actions{text-align:right}.uc-ledger-state{display:inline-block!important;border-radius:10px;padding:3px 7px;background:#eef1f4;color:#65717d!important;text-transform:capitalize}.uc-ledger-state.settled,.uc-ledger-state.authorised,.uc-ledger-state.paid{background:#e7f5f2;color:#0b7064!important}.uc-ledger-state.reversed,.uc-ledger-state.failed{background:#fff0f2;color:#9f2741!important}.uc-no-ledger{text-align:center;color:#718096;padding:35px!important}.uc-deposits{margin-top:18px;background:#fff;border:1px solid #d7dee5;padding:16px}.uc-deposits h3{margin:0 0 10px}.uc-deposits>div{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #e7ebef}.uc-deposits span{color:#526170}
.uc-floor{min-height:96px}.uc-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr))}.uc-unit{min-height:94px}
.uc-rent-badge{display:inline-flex!important;align-items:center;gap:6px;width:max-content;margin-top:8px;padding:5px 8px;border-radius:14px;background:#f3f6f8;color:var(--rent-color)!important;font-size:11px!important;font-weight:700;border:1px solid color-mix(in srgb,var(--rent-color) 24%,white)}.uc-rent-badge>i{width:7px!important;height:7px!important;border-radius:50%;background:var(--rent-color)!important;flex:none;position:static!important}.uc-rent-badge small{font-size:10px;font-weight:600;color:inherit}.uc-rent-badge.compact{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:3px 6px}.uc-rent-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding:10px 12px;background:#f7f9fb;border-left:3px solid #1c6fa6}.uc-rent-summary .uc-rent-badge{margin:0}.uc-rent-summary>span{font-size:11px;color:#718096}.uc-payment-preview{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#dfe6eb;margin-top:14px}.uc-payment-preview>div{background:#fff;padding:10px}.uc-payment-preview span,.uc-payment-preview strong{display:block}.uc-payment-preview span{font-size:10px;color:#718096}.uc-payment-preview strong{margin-top:3px}
@media(max-width:900px){.uc-profile-grid{grid-template-columns:1fr}.uc-ledger-stats{grid-template-columns:repeat(2,1fr)}.uc-ledger-toolbar{align-items:flex-start;flex-direction:column}.uc-stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){.uc{padding:16px}.uc-stats{grid-template-columns:repeat(2,1fr)}.uc-stats div{border-bottom:1px solid #e2e7eb}.uc-floor{grid-template-columns:38px 1fr}.uc-grid{grid-template-columns:repeat(2,1fr)}.uc-form-grid,.uc-summary-grid{grid-template-columns:1fr}.uc-form-grid .wide{grid-column:auto}.uc-search{width:100%}.uc-profile-head{flex-direction:column}.uc-profile-status{text-align:left}.uc-tabs{overflow:auto}.uc-tabs button{white-space:nowrap}.uc-ledger-toolbar>div:last-child{flex-wrap:wrap}}`;
