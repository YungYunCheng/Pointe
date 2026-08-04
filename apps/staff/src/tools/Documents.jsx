import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Document templates, AI field filling and approval
   Only templates marked Approved by counsel can generate a document.
        Anything a tenant will sign must be reviewed and signed off before it goes out.
   ============================================================ */

const KINDS = {
  lease:      "Residential lease",
  parking:    "Parking agreement",
  storage:    "Storage agreement",
  pet:        "Pet addendum",
  inspection: "Inspection report",
  notice:     "Notice",
  receipt:    "Receipt or acknowledgement",
  other:      "Other",
};

const STATUS = {
  missing:  { label: "Not uploaded",       color: "#8892A0" },
  draft:    { label: "Uploaded, not approved", color: "#C98A15" },
  approved: { label: "Approved by counsel", color: "#0E8577" },
  retired:  { label: "Retired",            color: "#B23A54" },
};

/* Opening checklist: the documents an Alberta rental normally needs */
const SEED = [
  { id: "d-lease",     name: "Residential Tenancy Agreement", kind: "lease",      status: "missing", note: "The main lease. Waiting on the lawyer’s version." },
  { id: "d-parking",   name: "Parking Agreement",             kind: "parking",    status: "missing", note: "Stalls are scarce. Keep this separate from the lease so it can be ended on its own." },
  { id: "d-storage",   name: "Storage Locker Agreement",      kind: "storage",    status: "missing" },
  { id: "d-pet",       name: "Pet Addendum",                  kind: "pet",        status: "missing", note: "Service animals are not pets and this addendum does not apply to them." },
  { id: "d-inspin",    name: "Move-in Inspection Report",     kind: "inspection", status: "missing", note: "Required in Alberta, completed at move-in." },
  { id: "d-inspout",   name: "Move-out Inspection Report",    kind: "inspection", status: "missing", note: "Required in Alberta, completed at move-out." },
  { id: "d-deposit",   name: "Security Deposit Receipt",      kind: "receipt",    status: "missing", note: "The deposit goes into a trust account; the receipt states where it is held." },
  { id: "d-keys",      name: "Key and Fob Acknowledgement",   kind: "receipt",    status: "missing" },
  { id: "d-renew",     name: "Renewal Notice",                kind: "notice",     status: "missing" },
  { id: "d-terminate", name: "Notice of Termination",         kind: "notice",     status: "missing", note: "Notice periods come from the RTA; have the template checked before use." },
  { id: "d-emergency", name: "Emergency Contact Form",        kind: "other",      status: "missing" },
];

const FIELD_SOURCES = {
  backend: { label: "From the system", color: "#1C6FA6", hint: "Filled from pricing, parking and unit data. The AI never touches these." },
  tenant:  { label: "Ask the tenant", color: "#0E8577", hint: "Collected during the intake conversation" },
  staff:   { label: "Staff enters",   color: "#C98A15", hint: "Needs human judgement, never automatic" },
};

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

/* ---------- Derive the unit type and layout from the unit number ---------- */
const BED = { "1A": "1 bed", "1A (M)": "1 bed", "1B": "1 bed + den", "1C": "1 bed",
              "2A": "2 bed 2 bath", "2A (M)": "2 bed 2 bath", "3A": "2 bed + den", "3A (M)": "2 bed + den" };
const G374 = {101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A"};
const T374 = {201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A"};
const G370 = {101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",117:"1A",118:"2A (M)"};
const T370 = {201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",217:"1A",218:"2A (M)",219:"3A (M)",220:"3A"};

function unitType(id) {
  const m = /^(370|374|378)-(\d{3})$/.exec((id || "").trim());
  if (!m) return null;
  const [, b, s] = m;
  const no = Number(s), floor = Math.floor(no / 100), key = no % 100;
  const g = b === "374" ? G374 : G370, t = b === "374" ? T374 : T370;
  if (floor === 1) return g[100 + key] || null;
  if (floor >= 2 && floor <= 6) return t[200 + key] || null;
  return null;
}

/* Inbox row title: unit · type · layout · name · phone · email */
function RowTitle({ unit, name, phone, email }) {
  const t = unitType(unit);
  return (
    <div className="dl-title">
      <span className="dl-t-unit">{unit || "No unit"}</span>
      {t && <><span className="dl-t-sep">·</span>
             <span className="dl-t-type">{t}</span>
             <span className="dl-t-bed">{BED[t]}</span></>}
      <span className="dl-t-sep">·</span>
      <span className="dl-t-name">{name || "No name"}</span>
      {phone && <><span className="dl-t-sep">·</span><a className="dl-t-c" href={`tel:${phone}`}>{phone}</a></>}
      {email && <><span className="dl-t-sep">·</span><a className="dl-t-c" href={`mailto:${email}`}>{email}</a></>}
    </div>
  );
}

export default function DocLibrary() {
  const [docs, setDocs] = useState(SEED);
  const [bodies, setBodies] = useState({});
  const [instances, setInstances] = useState([]);
  const [subs, setSubs] = useState([]);
  const [view, setView] = useState("new");   // new | viewed | done | all
  const [openKey, setOpenKey] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [session, setSession] = useState(null);
  const role = session?.role;
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("library");
  const [sel, setSel] = useState(null);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  /* ---------- Load ---------- */
  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch (e) { return null; }
      };
      const lib = await read("baydo:doclib");
      if (lib?.docs) setDocs(lib.docs);
      if (lib?.agent) setAgent(lib.agent);
      const inst = await read("baydo:docinst");
      if (inst) setInstances(inst);
      const q = await read("baydo:agentqueue");
      if (q) setSubs(q);
      const r = await read("baydo:session");
      if (r) { setSession(r); setTab(r.role === "admin" ? "library" : "sign"); if (r.name) setAgent(r.name); }
      const b = {};
      for (const d of (lib?.docs || SEED)) {
        if (d.hasBody) {
          try {
            const r = await window.storage.get("baydo:docbody:" + d.id);
            if (r?.value) b[d.id] = r.value;
          } catch (e) {}
        }
      }
      setBodies(b);
      setLoading(false);
    })();
  }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };

  const persist = useCallback(async (key, value) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set(key, typeof value === "string" ? value : JSON.stringify(value));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
  }, []);

  const saveDocs = (next, nextAgent = agent) => {
    setDocs(next);
    persist("baydo:doclib", { docs: next, agent: nextAgent });
  };
  const saveInst = (next) => { setInstances(next); persist("baydo:docinst", next); };
  const saveSubs = (next) => { setSubs(next); persist("baydo:agentqueue", next); };

  const patchDoc = (id, p) => saveDocs(docs.map((d) => (d.id === id ? { ...d, ...p } : d)));

  /* ---------- Upload ---------- */
  const onFile = async (id, file) => {
    if (!file) return;
    const isText = /\.(txt|md|markdown|html?|rtf)$/i.test(file.name) || file.type.startsWith("text/");
    if (!isText) {
      patchDoc(id, { status: "draft", fileName: file.name, fileSize: file.size, hasBody: false,
                     note: `Registered ${file.name} (${Math.round(file.size / 1024)} KB). PDF and Word need server-side parsing before blanks can be detected, so paste the text below for now.` });
      flash("File registered, but the browser cannot read this format. Paste the text instead.");
      return;
    }
    const text = await file.text();
    if (text.length > 200000) { flash("That file is too large. Split it or trim it first."); return; }
    setBodies((b) => ({ ...b, [id]: text }));
    await persist("baydo:docbody:" + id, text);
    patchDoc(id, { status: "draft", fileName: file.name, fileSize: file.size, hasBody: true,
                   fields: detectFields(text) });
    flash(`Uploaded. ${detectFields(text).length} blank(s) detected.`);
  };

  const pasteBody = async (id, text) => {
    setBodies((b) => ({ ...b, [id]: text }));
    await persist("baydo:docbody:" + id, text);
    patchDoc(id, { status: docs.find((d) => d.id === id)?.status === "approved" ? "draft" : "draft",
                   hasBody: true, fields: detectFields(text) });
  };

  const addDoc = () => {
    const d = { id: uid("d-"), name: "Untitled document", kind: "other", status: "missing" };
    saveDocs([...docs, d]); setSel(d.id);
  };

  /* ---------- AI proposes the field list ---------- */
  const aiFields = async (d) => {
    const text = bodies[d.id];
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 2000,
          messages: [{ role: "user", content:
`Below is a document template used for residential rentals in Alberta. Find every blank that needs filling and decide where each value should come from.

Document type: ${KINDS[d.kind]}
Template:
"""
${text.slice(0, 12000)}
"""

There are three sources:
- backend: pulled from property data (rent, deposit, fees, parking area, unit size, address)
- tenant: collected from the tenant (names, start date, term, number of occupants, emergency contact)
- staff: needs human judgement (special conditions, exceptions, signature dates)

Important: never mark a field as one to ask the tenant if it touches a protected ground — household composition, marital status, nationality, religion, age, income, employment or credit. If the template contains such a field, set source to staff and note in the note field that it needs legal review.

Output a JSON array only, no markdown:
[{"key":"snake_case_identifier","label":"Human label","source":"backend|tenant|staff","type":"text|number|date|select","note":"A caution where relevant, or null"}]` }],
        }),
      });
      const data = await res.json();
      const raw = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const fields = JSON.parse(raw.replace(/```json|```/g, "").trim());
      patchDoc(d.id, { fields });
      flash(`${fields.length} field(s) proposed. Check the source on each one.`);
    } catch (e) { flash("The AI service did not respond. Add the fields by hand."); }
    setBusy(false);
  };

  /* ---------- Create a document instance ---------- */
  const usable = docs.filter((d) => d.status === "approved" && d.hasBody);

  const makeInstance = (docId, unitId, tenant, phone, email) => {
    const d = docs.find((x) => x.id === docId);
    const inst = { id: uid("i-"), docId, docName: d.name, unitId, tenant, phone, email,
                   values: {}, state: "pending", createdAt: now() };
    saveInst([...instances, inst]);
    flash("Created and waiting for review.");
  };

  const setInstVal = (id, k, v) =>
    saveInst(instances.map((i) => (i.id === id ? { ...i, values: { ...i.values, [k]: v } } : i)));

  const approve = (id) => {
    if (!agent.trim()) return;
    saveInst(instances.map((i) => (i.id === id
      ? { ...i, state: "approved", approvedBy: agent, approvedAt: now() } : i)));
  };
  const sendOut = (id) =>
    saveInst(instances.map((i) => (i.id === id ? { ...i, state: "sent", sentAt: now() } : i)));

  const selDoc = docs.find((d) => d.id === sel);
  const pending = instances.filter((i) => i.state === "pending");
  const ready = docs.filter((d) => d.status === "approved").length;

  /* ---------- Inbox: tenant submissions and documents awaiting signature ---------- */
  const markSubRead = (id) =>
    saveSubs(subs.map((s) => (s.id === id && !s.read ? { ...s, read: true } : s)));
  const markInstRead = (id) =>
    saveInst(instances.map((i) => (i.id === id && !i.read ? { ...i, read: true } : i)));

  const inbox = useMemo(() => {
    const out = [];
    for (const s of subs) out.push({
      key: s.id, source: "sub", kind: s.kind || "lease", label: "Tenant submission",
      unitId: s.unitId, tenant: s.tenant, phone: s.phone, email: s.email, at: s.submittedAt,
      status: s.state === "done" ? "done" : s.read ? "viewed" : "new", raw: s,
    });
    for (const i of instances) {
      const d = docs.find((x) => x.id === i.docId);
      out.push({
        key: i.id, source: "doc", kind: d?.kind || "other", label: i.docName,
        unitId: i.unitId, tenant: i.tenant, phone: i.phone, email: i.email, at: i.createdAt,
        status: i.state !== "pending" ? "done" : i.read ? "viewed" : "new", raw: i, doc: d,
      });
    }
    return out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }, [subs, instances, docs]);

  const byState = { new: [], viewed: [], done: [] };
  inbox.forEach((x) => byState[x.status].push(x));

  const shown = view === "all" ? inbox : byState[view];
  const grouped = useMemo(() => {
    const g = {};
    shown.forEach((x) => { (g[x.kind] ||= []).push(x); });
    return Object.entries(g).sort((a, b) =>
      Object.keys(KINDS).indexOf(a[0]) - Object.keys(KINDS).indexOf(b[0]));
  }, [shown]);

  if (loading) return <div className="dl"><style>{CSS}</style><div className="dl-load">Loading templates…</div></div>;

  if (!session) return (
    <div className="dl">
      <style>{CSS}</style>
      <div className="dl-nosession">
        <div className="dl-nsbox">
          <div className="dl-eyebrow">Baydo Pointe</div>
          <h2 style={{ margin: "6px 0 8px" }}>Not signed in</h2>
          <p className="dl-note" style={{ margin: 0 }}>
            This tool uses the leasing console session. Sign in there first, then come back.
            What you can do here follows the role on your account and cannot be switched.
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="dl">
      <style>{CSS}</style>

      <header className="dl-head">
        <div>
          <div className="dl-eyebrow">Baydo Pointe · Documents</div>
          <h1>Templates and signing</h1>
        </div>
        <div className="dl-headr">
          <div className="dl-user">
            <span className="dl-rolechip"
                  style={{ background: role === "admin" ? "#131C25"
                           : role === "building_manager" ? "#7C5CBF" : "#1C6FA6" }}>
              {role === "admin" ? "Admin"
               : role === "building_manager" ? "Building Manager" : "Property Manager"}
            </span>
            <span className="dl-uname">{session?.name}</span>
          </div>
          <span className={`dl-save dl-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
        </div>
      </header>

      <nav className="dl-tabs">
        {role === "admin" && (
          <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
            Templates <i className="dl-b">{ready}/{docs.length}</i>
          </button>
        )}
        <button className={tab === "fill" ? "on" : ""} onClick={() => setTab("fill")}>Fill a document</button>
        <button className={tab === "sign" ? "on" : ""} onClick={() => setTab("sign")}>
          Inbox {byState.new.length > 0 && <i className="dl-b dl-b--warn">{byState.new.length}</i>}
        </button>
      </nav>

      {role !== "admin" && (
        <div className="dl-rolenote">
          {role === "building_manager" ? "Building Manager" : "Property Manager"} account:
          you can generate documents from approved templates and sign them off, but the template library is hidden.
          Uploading templates, marking the blanks and approving a version are Admin only.
        </div>
      )}

      {msg && <div className="dl-flash">{msg}</div>}

      {/* ══════════ Template library ══════════ */}
      {tab === "library" && role === "admin" && (
        <div className="dl-grid">
          <section className="dl-card">
            <h2>Documents <span className="dl-n">{docs.length}</span></h2>
            <p className="dl-note">
              These are the documents an Alberta rental normally needs. Upload each one as the lawyer’s version arrives; only approved templates can generate documents.
            </p>
            <div className="dl-list">
              {docs.map((d) => {
                const s = STATUS[d.status];
                return (
                  <button key={d.id} className={`dl-item ${sel === d.id ? "on" : ""}`}
                          onClick={() => setSel(d.id)} style={{ "--s": s.color }}>
                    <div className="dl-item-h">
                      <span className="dl-kind">{KINDS[d.kind]}</span>
                      <span className="dl-pill">{s.label}</span>
                    </div>
                    <strong>{d.name}</strong>
                    {d.fields?.length > 0 && <span className="dl-dim">{d.fields.length} blanks</span>}
                  </button>
                );
              })}
            </div>
            <button className="dl-btn dl-btn--ghost" style={{ marginTop: 12 }} onClick={addDoc}>
              New document
            </button>
          </section>

          <section className="dl-card">
            {!selDoc ? <div className="dl-empty">Pick a document on the left.</div> : (
              <>
                <div className="dl-row">
                  <label className="dl-field" style={{ flex: "2 1 200px" }}>
                    <span>Document name</span>
                    <input className="dl-in" value={selDoc.name}
                           onChange={(e) => patchDoc(selDoc.id, { name: e.target.value })} />
                  </label>
                  <label className="dl-field" style={{ flex: "1 1 120px" }}>
                    <span>Type</span>
                    <select className="dl-sel" value={selDoc.kind}
                            onChange={(e) => patchDoc(selDoc.id, { kind: e.target.value })}>
                      {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                </div>

                <div className="dl-upload">
                  <div className="dl-upload-h">
                    <strong>Upload a template</strong>
                    <span className="dl-dim">.txt, .md and .html have their blanks detected automatically</span>
                  </div>
                  <input className="dl-file" type="file" accept=".txt,.md,.markdown,.html,.htm,.rtf,.pdf,.doc,.docx"
                         onChange={(e) => onFile(selDoc.id, e.target.files?.[0])} />
                  {selDoc.fileName && (
                    <div className="dl-dim" style={{ marginTop: 6 }}>
                      Registered: {selDoc.fileName}
                      {selDoc.fileSize ? `（${Math.round(selDoc.fileSize / 1024)} KB）` : ""}
                    </div>
                  )}
                  <div className="dl-hint">
                    The browser cannot read PDF or Word; production needs server-side conversion. For now paste the text below
                    and mark each blank with double braces, for example <code>{"{{tenant_name}}"}</code>.
                  </div>
                  <textarea className="dl-ta" rows={9} value={bodies[selDoc.id] || ""}
                            placeholder={"Paste the template. Mark blanks as {{field_name}}…"}
                            onChange={(e) => setBodies((b) => ({ ...b, [selDoc.id]: e.target.value }))}
                            onBlur={(e) => pasteBody(selDoc.id, e.target.value)} />
                </div>

                <div className="dl-row">
                  <label className="dl-field">
                    <span>Status</span>
                    <select className="dl-sel" value={selDoc.status}
                            onChange={(e) => patchDoc(selDoc.id, {
                              status: e.target.value,
                              ...(e.target.value === "approved"
                                  ? { approvedBy: agent || "unsigned", approvedAt: now() } : {}) })}>
                      {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </label>
                  <label className="dl-field">
                    <span>Version</span>
                    <input className="dl-in" value={selDoc.version || ""} placeholder="e.g. 2026-08 counsel version"
                           onChange={(e) => patchDoc(selDoc.id, { version: e.target.value })} />
                  </label>
                </div>
                {selDoc.status === "approved" && (
                  <div className="dl-ok">
                    Approved by {selDoc.approvedBy || "—"} · {selDoc.approvedAt || "—"} — available for use
                  </div>
                )}

                <label className="dl-field">
                  <span>Notes</span>
                  <textarea className="dl-ta dl-ta--sm" rows={2} value={selDoc.note || ""}
                            onChange={(e) => patchDoc(selDoc.id, { note: e.target.value })} />
                </label>

                <div className="dl-fields">
                  <div className="dl-fields-h">
                    <strong>Blanks and their source <span className="dl-n">{selDoc.fields?.length || 0}</span></strong>
                    <button className="dl-btn dl-btn--sm" disabled={!bodies[selDoc.id] || busy}
                            onClick={() => aiFields(selDoc)}>
                      {busy ? "Working…" : "Propose fields with AI"}
                    </button>
                  </div>
                  <p className="dl-note">
                    The AI only lists the blanks and suggests where each value comes from, and later it only fills blanks. It never touches the clause text.
                    Anything marked From the system is written by the system directly; the AI does not fill those at all.
                  </p>
                  {!selDoc.fields?.length ? (
                    <div className="dl-empty">No fields yet. Upload or paste a template and {"{{...}}"} markers are detected automatically.</div>
                  ) : (
                    <div className="dl-ftable">
                      {selDoc.fields.map((f, i) => {
                        const src = FIELD_SOURCES[f.source] || FIELD_SOURCES.staff;
                        return (
                          <div className="dl-frow" key={f.key + i}>
                            <span className="dl-mono">{f.key}</span>
                            <span>{f.label || f.key}</span>
                            <select className="dl-sel dl-sel--xs" value={f.source || "staff"}
                                    onChange={(e) => patchDoc(selDoc.id, {
                                      fields: selDoc.fields.map((x, j) =>
                                        j === i ? { ...x, source: e.target.value } : x) })}>
                              {Object.entries(FIELD_SOURCES).map(([k, v]) =>
                                <option key={k} value={k}>{v.label}</option>)}
                            </select>
                            {f.note && <span className="dl-fnote">{f.note}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ══════════ Fill ══════════ */}
      {tab === "fill" && (
        <div className="dl-single">
          <section className="dl-card">
            <h2>Generate a document</h2>
            {usable.length === 0 ? (
              <div className="dl-gate">
                <strong>No templates are available.</strong>
                <p>
                  Only a template that is approved and has content can generate a document. That is deliberate:
                  putting an unreviewed version in front of a tenant to sign costs far more than the time it saves.
                </p>
                <p className="dl-dim">Upload one under Templates and set it to approved.</p>
              </div>
            ) : (
              <NewInstance docs={usable} onCreate={makeInstance} />
            )}
          </section>

          {instances.filter((i) => i.state !== "sent").length > 0 && (
            <section className="dl-card">
              <h2>In progress <span className="dl-n">{instances.filter((i) => i.state !== "sent").length}</span></h2>
              {instances.filter((i) => i.state !== "sent").map((i) => {
                const d = docs.find((x) => x.id === i.docId);
                return (
                  <InstanceEditor key={i.id} inst={i} doc={d} body={bodies[i.docId]}
                                  onSet={(k, v) => setInstVal(i.id, k, v)} />
                );
              })}
            </section>
          )}
        </div>
      )}

      {/* ══════════ Inbox ══════════ */}
      {tab === "sign" && (
        <div className="dl-single">
          <div className="dl-agentbar">
            <div className="dl-field" style={{ maxWidth: 300 }}>
              <span>Signed off by</span>
              <div className="dl-signer">
                <span className="dl-rolechip"
                      style={{ background: role === "admin" ? "#131C25"
                               : role === "building_manager" ? "#7C5CBF" : "#1C6FA6" }}>
                  {role === "admin" ? "Admin"
                   : role === "building_manager" ? "Building Manager" : "Property Manager"}
                </span>
                <strong>{session?.name}</strong>
              </div>
              <span className="dl-dim">Taken from your account. This is the name recorded against the approval.</span>
            </div>
            <div className="dl-agentstat">
              <div><em>New</em><strong className="dl-hot">{byState.new.length}</strong></div>
              <div><em>Read, open</em><strong>{byState.viewed.length}</strong></div>
              <div><em>Handled</em><strong>{byState.done.length}</strong></div>
            </div>
          </div>

          {/* Status tabs */}
          <div className="dl-views">
            {[["new", "New", byState.new.length],
              ["viewed", "Read", byState.viewed.length],
              ["done", "Handled", byState.done.length],
              ["all", "All", inbox.length]].map(([k, l, n]) => (
              <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
                {l}<i>{n}</i>
              </button>
            ))}
          </div>

          {/* Grouped by document type */}
          {grouped.length === 0 ? (
            <section className="dl-card">
              <div className="dl-empty">
                {view === "new" ? "Nothing new. Tenant submissions from the intake tool land here."
                  : view === "viewed" ? "Nothing read and still open."
                  : view === "done" ? "Nothing handled yet." : "The inbox is empty."}
              </div>
            </section>
          ) : grouped.map(([kind, items]) => {
            const isCollapsed = collapsed[kind];
            const newCount = items.filter((x) => x.status === "new").length;
            return (
              <section className="dl-card dl-group" key={kind}>
                <button className="dl-grouph" onClick={() => setCollapsed({ ...collapsed, [kind]: !isCollapsed })}>
                  <span className="dl-gcaret">{isCollapsed ? "▸" : "▾"}</span>
                  <h2>{KINDS[kind]}</h2>
                  <span className="dl-n">{items.length}</span>
                  {newCount > 0 && <span className="dl-newdot">{newCount} new</span>}
                </button>
                {!isCollapsed && (
                  <div className="dl-cards">
                    {items.map((x) => (
                      <InboxCard
                        key={x.key} item={x} agent={agent}
                        open={openKey === x.key}
                        onToggle={() => {
                          const nowOpen = openKey !== x.key;
                          setOpenKey(nowOpen ? x.key : null);
                          if (nowOpen && x.status === "new") {
                            x.source === "sub" ? markSubRead(x.key) : markInstRead(x.key);
                          }
                        }}
                        onAcceptSub={() => saveSubs(subs.map((s) => s.id === x.key
                          ? { ...s, state: "done", read: true, acceptedBy: agent, acceptedAt: now() } : s))}
                        onRejectSub={() => saveSubs(subs.filter((s) => s.id !== x.key))}
                        onApprove={() => approve(x.key)}
                        onReject={() => saveInst(instances.filter((i) => i.id !== x.key))}
                        onSend={() => sendOut(x.key)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <footer className="dl-foot">
        Prototype. Every template must be settled by a lawyer against the Alberta Residential Tenancies Act.
        This tool does not check whether a clause is lawful. It controls which version may be used, whether the blanks are filled, and who signed off.
        The browser cannot read PDF or Word; production needs server-side conversion and version comparison.
      </footer>
    </div>
  );
}

/* ============================ Sub-components ============================ */

function NewInstance({ docs, onCreate }) {
  const [docId, setDocId] = useState(docs[0]?.id || "");
  const [unit, setUnit] = useState("");
  const [tenant, setTenant] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const t = unitType(unit);
  return (
    <>
      <div className="dl-row">
        <label className="dl-field" style={{ flex: "2 1 220px" }}>
          <span>Template</span>
          <select className="dl-sel" value={docId} onChange={(e) => setDocId(e.target.value)}>
            {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="dl-field"><span>Unit number</span>
          <input className="dl-in" value={unit} placeholder="378-519"
                 onChange={(e) => setUnit(e.target.value)} />
          <span className="dl-dim">{unit ? (t ? `${t} · ${BED[t]}` : "No unit with that number") : "Type a unit to see its layout"}</span>
        </label>
        <label className="dl-field"><span>Tenant</span>
          <input className="dl-in" value={tenant} placeholder="Name"
                 onChange={(e) => setTenant(e.target.value)} /></label>
      </div>
      <div className="dl-row">
        <label className="dl-field"><span>Phone</span>
          <input className="dl-in" value={phone} placeholder="780-555-0142"
                 onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="dl-field"><span>Email</span>
          <input className="dl-in" type="email" value={email} placeholder="name@example.com"
                 onChange={(e) => setEmail(e.target.value)} /></label>
        <button className="dl-btn" style={{ alignSelf: "flex-end", flex: "0 0 auto" }}
                disabled={!docId || !unit.trim() || !tenant.trim()}
                onClick={() => { onCreate(docId, unit.trim(), tenant.trim(), phone.trim(), email.trim());
                                 setUnit(""); setTenant(""); setPhone(""); setEmail(""); }}>
          Send to the inbox
        </button>
      </div>
    </>
  );
}

const ST_BADGE = {
  new:    { label: "New",     color: "#B23A54" },
  viewed: { label: "Read",    color: "#C98A15" },
  done:   { label: "Handled", color: "#0E8577" },
};

function InboxCard({ item, agent, open, onToggle, onAcceptSub, onRejectSub, onApprove, onReject, onSend }) {
  const b = ST_BADGE[item.status];
  const isSub = item.source === "sub";
  const raw = item.raw;
  const blanks = !isSub ? (item.doc?.fields || []).filter((f) => !raw.values[f.key]) : [];

  return (
    <div className={`dl-gatebox dl-c--${item.status}`}>
      <button className="dl-subhead" onClick={onToggle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <RowTitle unit={item.unitId} name={item.tenant} phone={item.phone} email={item.email} />
          <div className="dl-sub2">
            <span className="dl-badge" style={{ "--b": b.color }}>{b.label}</span>
            <span className="dl-docname">{item.label}</span>
            <span className="dl-mono dl-dim">{item.at}</span>
            {isSub && raw.fees && (
              <span className="dl-dim">
                Fees confirmed · ${Number(raw.fees.monthlyTotal || 0).toLocaleString("en-CA")}/mo
                 · ${Number(raw.fees.upfrontTotal || 0).toLocaleString("en-CA")} up front
              </span>
            )}
          </div>
        </div>
        <span className="dl-caret">{open ? "▾" : "▸"}</span>
      </button>

      {open && (isSub ? (
        <>
          <div className="dl-ftable">
            {Object.entries(raw.variables || {}).map(([k, v]) => (
              <div className="dl-frow" key={k}>
                <span className="dl-mono">{k}</span>
                <span>{v == null || v === "" ? <em className="dl-dim">blank</em> : String(v)}</span>
              </div>
            ))}
            {Object.keys(raw.variables || {}).length === 0 &&
              <div className="dl-frow"><span className="dl-dim">No field data</span></div>}
          </div>
          {item.status === "done" ? (
            <div className="dl-good">Checked by {raw.acceptedBy} · {raw.acceptedAt}</div>
          ) : (
            <div className="dl-gate-a">
              <button className="dl-btn" disabled={!agent.trim()} onClick={onAcceptSub}>Details look right</button>
              <button className="dl-btn dl-btn--ghost" onClick={onRejectSub}>Send back</button>
              {!agent.trim() && <span className="dl-dim">Sign in to approve</span>}
            </div>
          )}
        </>
      ) : (
        <>
          <div className={blanks.length ? "dl-bad" : "dl-good"}>
            {blanks.length
              ? `${blanks.length} blank(s) still empty: ${blanks.map((x) => x.label || x.key).join(", ")}`
              : "Every blank is filled"}
          </div>
          {item.status !== "done" && (
            <ul className="dl-check">
              <li>Template is an approved version ({item.doc?.version || "no version set"})</li>
              <li>Amounts match the current settings</li>
              <li>Tenant has confirmed the fees</li>
              <li>Clause text is unmodified</li>
            </ul>
          )}
          {item.status === "done" ? (
            <div className="dl-gate-a">
              <span style={{ color: raw.state === "sent" ? "#0E8577" : "#1C6FA6", fontSize: 12.5 }}>
                {raw.state === "sent" ? `Sent to the tenant ${raw.sentAt}` : "Approved, not yet sent"}
              </span>
              <span className="dl-dim">Signed off by {raw.approvedBy} · {raw.approvedAt}</span>
              {raw.state === "approved" && (
                <button className="dl-btn dl-btn--sm" onClick={onSend}>Send to tenant</button>
              )}
            </div>
          ) : (
            <div className="dl-gate-a">
              <button className="dl-btn" disabled={!agent.trim() || blanks.length > 0}
                      onClick={onApprove}>Approve and sign</button>
              <button className="dl-btn dl-btn--ghost" onClick={onReject}>Send back</button>
              {!agent.trim() && <span className="dl-dim">Sign in to approve</span>}
            </div>
          )}
        </>
      ))}
    </div>
  );
}

function InstanceEditor({ inst, doc, body, onSet }) {
  const [open, setOpen] = useState(false);
  const fields = doc?.fields || [];
  const filled = fields.filter((f) => inst.values[f.key]).length;
  const preview = useMemo(() => {
    if (!body) return "";
    return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) =>
      inst.values[k] ? inst.values[k] : `[${k} not filled]`);
  }, [body, inst.values]);

  return (
    <div className="dl-inst">
      <button className="dl-inst-h" onClick={() => setOpen(!open)}>
        <strong>{inst.docName}</strong>
        <span className="dl-dim">{inst.unitId} · {inst.tenant}</span>
        <span className="dl-mono dl-dim">{filled}/{fields.length} filled</span>
        <span className="dl-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="dl-inst-b">
          <div className="dl-ftable">
            {fields.map((f) => {
              const src = FIELD_SOURCES[f.source] || FIELD_SOURCES.staff;
              return (
                <div className="dl-frow" key={f.key}>
                  <span className="dl-mono">{f.key}</span>
                  <span className="dl-srcpill" style={{ "--c": src.color }}>{src.label}</span>
                  <input className="dl-in dl-in--sm" value={inst.values[f.key] || ""}
                         placeholder={f.label || f.key}
                         onChange={(e) => onSet(f.key, e.target.value)} />
                </div>
              );
            })}
          </div>
          {preview && (
            <>
              <div className="dl-prev-h">Preview</div>
              <pre className="dl-prev">{preview}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* Detect {{field}} markers */
function detectFields(text) {
  const set = new Map();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(text))) if (!set.has(m[1])) set.set(m[1], { key: m[1], label: m[1], source: "staff", type: "text" });
  return [...set.values()];
}

/* ============================ Styles ============================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.dl{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:#1C6FA6;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.dl *{box-sizing:border-box}
.dl-mono{font-family:'IBM Plex Mono',monospace}
.dl-dim{color:var(--dim);font-size:12px}
.dl-load{padding:80px 24px;text-align:center;color:var(--dim)}

.dl-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.dl-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.dl-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.dl-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.dl-save--saved{color:var(--green);border-color:var(--green)}
.dl-save--error{color:var(--red);border-color:var(--red)}

.dl-tabs{display:flex;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--rule)}
.dl-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 18px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:7px}
.dl-tabs button.on{color:var(--ink);border-bottom-color:var(--ink)}
.dl-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;border:1px solid var(--rule);
  border-radius:8px;padding:1px 6px;color:var(--dim)}
.dl-b--warn{background:var(--red);color:#fff;border-color:var(--red)}
.dl-user{display:flex;align-items:center;gap:8px}
.dl-rolechip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px;
  letter-spacing:.04em;flex:0 0 auto}
.dl-uname{font-size:13px;font-weight:600}
.dl-signer{display:flex;align-items:center;gap:8px;border:1px solid var(--rule);border-radius:3px;
  padding:6px 10px;background:var(--paper)}
.dl-signer strong{font-size:13px}
.dl-nosession{min-height:70vh;display:flex;align-items:center;justify-content:center;padding:24px}
.dl-nsbox{background:var(--paper);border:1px solid var(--rule);border-radius:5px;padding:26px 24px;
  width:min(420px,100%)}
.dl-rolenote{background:#F2F7FB;border-bottom:1px solid #C7D6E2;padding:10px 28px;font-size:12.5px;
  color:var(--ink2);line-height:1.6}

.dl-flash{background:#F2F7FB;border-bottom:1px solid #C7D6E2;padding:9px 28px;font-size:12.5px;
  color:var(--ink2)}

.dl-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--ink);color:#fff;
  border:1px solid var(--ink);padding:8px 15px;border-radius:3px}
.dl-btn:hover:not(:disabled){background:#000}
.dl-btn:disabled{opacity:.4;cursor:not-allowed}
.dl-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.dl-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.dl-btn--sm{padding:5px 11px;font-size:12px}
.dl-btn:focus-visible,.dl-in:focus-visible,.dl-sel:focus-visible,.dl-ta:focus-visible,
.dl-item:focus-visible,.dl-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.dl-in,.dl-sel,.dl-ta{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%;min-width:0}
.dl-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}
.dl-sel--xs{padding:4px 7px;font-size:11.5px;width:auto}
.dl-in--sm{padding:5px 8px;font-size:12.5px}
.dl-ta{font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;resize:vertical}
.dl-ta--sm{font-family:inherit;font-size:13px}
.dl-file{font:inherit;font-size:12.5px}

.dl-grid{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:16px;padding:18px 28px;
  align-items:start;max-width:1340px}
.dl-single{display:flex;flex-direction:column;gap:16px;padding:18px 28px;max-width:1100px}
.dl-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px;
  display:flex;flex-direction:column;gap:14px}
.dl-card--gate{border-color:var(--amberline);background:linear-gradient(180deg,#FFFCF3 0%,#fff 55%)}
.dl-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0;
  display:flex;align-items:center;gap:8px}
.dl-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.dl-note{color:var(--dim);font-size:12.5px;margin:-6px 0 0;line-height:1.6}
.dl-empty{color:var(--dim);font-size:12.5px;padding:20px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

.dl-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden;max-height:520px;overflow-y:auto}
.dl-item{font:inherit;text-align:left;cursor:pointer;background:var(--paper);border:0;
  border-left:3px solid var(--s);padding:9px 12px;display:flex;flex-direction:column;gap:2px}
.dl-item:hover{background:#F6F9FB}
.dl-item.on{background:#F2F7FB}
.dl-item strong{font-size:13px;font-weight:600;line-height:1.4}
.dl-item-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.dl-kind{font-size:10.5px;color:var(--dim);font-family:'IBM Plex Mono',monospace}
.dl-pill{font-size:10.5px;font-weight:600;color:var(--s);border:1px solid var(--s);border-radius:9px;
  padding:1px 7px;white-space:nowrap}

.dl-row{display:flex;gap:12px;flex-wrap:wrap}
.dl-row>*{flex:1 1 150px}
.dl-field{display:flex;flex-direction:column;gap:5px}
.dl-field>span{font-size:12px;font-weight:600;color:var(--ink2)}

.dl-upload{border:1px dashed var(--rule);border-radius:3px;padding:13px 14px;display:flex;
  flex-direction:column;gap:8px;background:#FCFDFE}
.dl-upload-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px}
.dl-hint{font-size:11.5px;color:var(--dim);line-height:1.6}
.dl-hint code{font-family:'IBM Plex Mono',monospace;background:var(--ground);padding:1px 5px;
  border-radius:2px;font-size:11px}
.dl-ok{font-size:12px;color:var(--green);border:1px solid var(--green);border-radius:3px;
  padding:7px 11px;background:#F6FBF8}

.dl-fields{border-top:1px solid var(--rule);padding-top:14px;display:flex;flex-direction:column;gap:10px}
.dl-fields-h{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.dl-fields-h strong{font-size:13px}
.dl-ftable{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.dl-frow{display:flex;align-items:center;gap:10px;padding:6px 11px;background:var(--paper);
  font-size:12.5px;flex-wrap:wrap}
.dl-frow>span:first-child{font-size:11.5px;color:var(--accent);flex:0 0 auto}
.dl-frow>span:nth-child(2){flex:1 1 100px}
.dl-frow .dl-in{flex:1 1 140px;width:auto}
.dl-fnote{font-size:11px;color:#C98A15;flex:1 1 100%}
.dl-srcpill{font-size:10.5px;font-weight:600;color:var(--c);border:1px solid var(--c);border-radius:9px;
  padding:1px 7px;flex:0 0 auto !important}

.dl-gate{border:1px solid var(--amberline);background:#FFFCF3;border-radius:3px;padding:16px 18px}
.dl-gate strong{font-size:13.5px}
.dl-gate p{margin:7px 0 0;font-size:12.5px;line-height:1.7;color:var(--ink2)}

.dl-inst{border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.dl-inst-h{font:inherit;width:100%;text-align:left;cursor:pointer;background:#FCFDFE;border:0;
  padding:10px 13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dl-inst-h strong{font-size:13px}
.dl-caret{margin-left:auto;color:var(--dim)}
.dl-inst-b{padding:12px 13px;border-top:1px solid var(--rule);display:flex;flex-direction:column;gap:10px}
.dl-prev-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--dim)}
.dl-prev{font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.75;background:#F7F9FB;
  border:1px solid var(--rule);border-radius:3px;padding:12px 14px;margin:0;white-space:pre-wrap;
  max-height:300px;overflow-y:auto;color:var(--ink2)}

.dl-gatebox{border:1px solid var(--rule);border-radius:3px;padding:13px 14px;background:var(--paper);
  display:flex;flex-direction:column;gap:9px}

/* Inbox row title */
.dl-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:13.5px;line-height:1.5}
.dl-t-unit{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:15px}
.dl-t-type{font-family:'IBM Plex Mono',monospace;font-weight:600;color:var(--accent);font-size:13px}
.dl-t-bed{font-size:11.5px;color:var(--ink2);border:1px solid var(--rule);border-radius:9px;padding:1px 8px}
.dl-t-name{font-weight:600}
.dl-t-sep{color:var(--rule)}
.dl-t-c{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink2);text-decoration:none;
  border-bottom:1px dotted var(--dim)}
.dl-t-c:hover{color:var(--accent);border-bottom-color:var(--accent)}
.dl-sub2{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.dl-docname{font-size:12.5px;font-weight:600;color:var(--ink2)}
.dl-subhead{font:inherit;width:100%;text-align:left;cursor:pointer;background:none;border:0;padding:0;
  display:flex;align-items:center;gap:10px}
.dl-donebox{border-top:1px dotted var(--rule);padding-top:10px;display:flex;flex-direction:column;gap:6px}

.dl-agentbar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:14px 18px}
.dl-agentstat{display:flex;gap:22px}
.dl-agentstat div{display:flex;flex-direction:column}
.dl-agentstat em{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10.5px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.dl-agentstat strong{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600}
.dl-hot{color:var(--red)}

/* Status tabs */
.dl-views{display:flex;gap:6px;flex-wrap:wrap}
.dl-views button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:7px 14px;color:var(--dim);
  display:flex;align-items:center;gap:7px}
.dl-views button:hover{color:var(--ink)}
.dl-views button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.dl-views i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:11px;
  background:var(--ground);color:var(--ink2);border-radius:8px;padding:0 7px}
.dl-views button.on i{background:rgba(255,255,255,.22);color:#fff}

/* Grouping */
.dl-group{gap:0;padding:0;overflow:hidden}
.dl-grouph{font:inherit;width:100%;text-align:left;cursor:pointer;background:#F7F9FB;border:0;
  border-bottom:1px solid var(--rule);padding:11px 18px;display:flex;align-items:center;gap:10px}
.dl-grouph h2{font-size:14px}
.dl-gcaret{color:var(--dim);font-size:11px}
.dl-newdot{font-size:10.5px;font-weight:700;color:#fff;background:var(--red);border-radius:9px;
  padding:1px 8px;margin-left:auto}
.dl-cards{display:flex;flex-direction:column;gap:1px;background:var(--rule)}
.dl-cards>.dl-gatebox{border:0;border-radius:0;border-left:3px solid transparent}
.dl-c--new{border-left-color:var(--red) !important;background:#FFFCFC !important}
.dl-c--viewed{border-left-color:var(--amberline) !important}
.dl-c--done{border-left-color:var(--green) !important;opacity:.82}
.dl-badge{font-size:10.5px;font-weight:700;color:#fff;background:var(--b);border-radius:9px;
  padding:1px 8px;flex:0 0 auto}
.dl-gate-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dl-gate-h strong{font-size:13.5px}
.dl-good{font-size:12.5px;color:var(--green)}
.dl-bad{font-size:12.5px;color:var(--red)}
.dl-check{margin:0;padding-left:17px;font-size:12px;color:var(--ink2);line-height:1.8}
.dl-gate-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dl-done{display:flex;align-items:center;gap:10px;font-size:12.5px;padding:8px 0;
  border-top:1px dotted var(--rule);flex-wrap:wrap}

.dl-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:88ch;line-height:1.65}

@media (max-width:880px){
  .dl-grid{grid-template-columns:1fr;padding:16px}
  .dl-single{padding:16px}
  .dl-head,.dl-tabs,.dl-flash,.dl-foot{padding-left:16px;padding-right:16px}
}
`;
