import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Leads CRM, showing schedule and funnel
   The showing schedule reads baydo:schedule directly, so both tools stay in step.
   ============================================================ */

const STAGES = [
  { k: "new",       label: "New enquiry",   color: "#B23A54", sla: 1 },
  { k: "contacted", label: "Contacted",     color: "#C98A15", sla: 48 },
  { k: "booked",    label: "Showing booked",color: "#1C6FA6", sla: null },
  { k: "viewed",    label: "Viewed",        color: "#7C5CBF", sla: 48 },
  { k: "applied",   label: "Applied",       color: "#0E8577", sla: 24 },
  { k: "leased",    label: "Leased",        color: "#0B6B4F", sla: null },
  { k: "lost",      label: "Lost",          color: "#8892A0", sla: null },
];
const ST = Object.fromEntries(STAGES.map((s) => [s.k, s]));
const OPEN_STAGES = ["new", "contacted", "booked", "viewed", "applied"];

const SOURCES = ["Web form", "Email", "SMS", "WhatsApp", "Phone", "Walk-in", "Referral", "Kijiji", "Rentals.ca", "Other"];

const LOST_REASONS = [
  "Price", "No suitable layout", "Timing", "Took another property",
  "Not enough parking", "Pet policy", "Went quiet", "Other",
];

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
  const no = Number(s), fl = Math.floor(no / 100), key = no % 100;
  const g = b === "374" ? G374 : G370, t = b === "374" ? T374 : T370;
  if (fl === 1) return g[100 + key] || null;
  if (fl >= 2 && fl <= 6) return t[200 + key] || null;
  return null;
}

const pad = (n) => String(n).padStart(2, "0");
const isoD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addD = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return isoD(d); };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pretty = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)} (${WD[parseD(s).getDay()]})`;
const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3.6e6 : null);
const fmtH = (h) => (h == null ? "—" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`);
const uid = () => "ld_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ---------- Duplicate detection ----------

   An email or phone already on file is a hard stop: the same person cannot
   apply twice under the same contact details.

   A resemblance is not, and that is deliberate. Two people with the same
   common surname are two people. Refusing one of them automatically would
   fall unevenly across communities where a handful of surnames are shared by
   thousands of families, and under the Alberta Human Rights Act that pattern
   is a problem whatever was intended by the rule. So a close match is flagged
   and a person decides, with the reason recorded.                          */

const SIMILARITY_FLAG = 0.70;

const normEmail = (s) => {
  const e = String(s ?? "").trim().toLowerCase();
  if (!e.includes("@")) return e;
  const [local, domain] = e.split("@");
  // Gmail ignores dots and anything after a plus, so a.b+x@gmail.com and
  // ab@gmail.com are one mailbox. Treating them as two lets one person apply
  // repeatedly with what look like different addresses.
  if (/^(gmail|googlemail)\.com$/.test(domain))
    return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return `${local.split("+")[0]}@${domain}`;
};

const normPhone = (s) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

const normName = (s) => String(s ?? "").trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");

function editSimilarity(a, b) {
  const s = normName(a), t = normName(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
}

/** Word overlap, so a reordered name still scores. "Chen Wei-Lun" and
 *  "Wei-Lun Chen" are one person written two ways. */
function tokenOverlap(a, b) {
  const s = new Set(normName(a).split(" ").filter(Boolean));
  const t = new Set(normName(b).split(" ").filter(Boolean));
  if (!s.size || !t.size) return 0;
  let hit = 0;
  for (const x of s) if (t.has(x)) hit++;
  return hit / Math.max(s.size, t.size);
}

const nameSimilarity = (a, b) => Math.max(editSimilarity(a, b), tokenOverlap(a, b));

/** Finds people who are on file more than once. The same person enquires,
 *  applies, signs and renews, and turns up as several records — merging keeps
 *  one and folds the rest into it. */
export function findDuplicates(leads) {
  const groups = new Map();
  for (const l of leads) {
    const key = normEmail(l.email) || normPhone(l.phone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const order = ["leased", "applied", "viewed", "booked", "contacted", "new", "lost"];
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const sorted = [...rows].sort((a, b) =>
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
      return {
        key,
        // The oldest is kept: it holds the first contact date, which is what
        // the response-time figures are measured from.
        keep: sorted[0],
        merge: sorted.slice(1),
        // The furthest-along stage survives. Somebody who signed a lease is
        // not "new" because they enquired again about a second unit.
        stage: order.find((st) => rows.some((r) => r.stage === st)),
      };
    });
}

export function screenLead({ email, phone, name }, existing, excludeId) {
  const e = normEmail(email), p = normPhone(phone);

  for (const l of existing) {
    if (excludeId && l.id === excludeId) continue;
    if (e && normEmail(l.email) === e)
      return { result: "duplicate", type: "email", match: l, similarity: 1,
        detail: `This email is already on file for ${l.name}, added ${String(l.created_at).slice(0, 10)}.` };
    if (p && p.length >= 10 && normPhone(l.phone) === p)
      return { result: "duplicate", type: "phone", match: l, similarity: 1,
        detail: `This phone number is already on file for ${l.name}.` };
  }

  // A name alone never flags: a shared surname is common and means nothing on
  // its own. It counts only alongside a partial match on a contact detail.
  let best = null;
  for (const l of existing) {
    if (excludeId && l.id === excludeId) continue;
    const nameScore = nameSimilarity(name, l.name);
    if (nameScore < SIMILARITY_FLAG) continue;
    const emailScore = e && l.email ? editSimilarity(e, normEmail(l.email)) : 0;
    const phoneScore = p && l.phone
      ? (p.slice(-7) === normPhone(l.phone).slice(-7) ? 0.9 : editSimilarity(p, normPhone(l.phone)))
      : 0;
    const contact = Math.max(emailScore, phoneScore);
    if (contact < 0.5) continue;
    const combined = nameScore * 0.5 + contact * 0.5;
    if (!best || combined > best.similarity)
      best = { result: "review", type: "similarity", match: l,
        similarity: Number(combined.toFixed(3)),
        detail: `Resembles ${l.name} (${l.email || l.phone || "no contact on file"}): name ${(nameScore * 100).toFixed(0)}% alike, contact ${(contact * 100).toFixed(0)}% alike.` };
  }
  if (best) return best;

  return { result: "clear", type: null, match: null, similarity: 0, detail: null };
}
const nowISO = () => new Date().toISOString();

function seedLeads() {
  const t = Date.now();
  const ago = (h) => new Date(t - h * 3.6e6).toISOString();
  return [
    { id: "ld_1", name: "Jenny Tran", phone: "780-555-0142", email: "j.tran@example.com",
      source: "Email", stage: "new", units: ["370-412"], beds: "2 bed", moveIn: "",
      assigned: "", created_at: ago(3), last_contact_at: null, next_action_at: "", dnc: false,
      notes: [{ at: ago(3), by: "System", text: "Emailed asking about a two bedroom for Sept 1, rent and parking." }] },
    { id: "ld_2", name: "Wei-Lun Chen", phone: "780-555-0193", email: "wchen@example.com",
      source: "Web form", stage: "contacted", units: ["374-311"], beds: "1 bed", moveIn: "2026-09-01",
      assigned: "Bowen Wang", created_at: ago(30), last_contact_at: ago(26), next_action_at: "", dnc: false,
      notes: [{ at: ago(26), by: "AI", text: "Auto-replied with the pet policy and fees." }] },
    { id: "ld_3", name: "Priya Nair", phone: "780-555-0177", email: "p.nair@example.com",
      source: "SMS", stage: "booked", units: ["378-315"], beds: "2 bed", moveIn: "2026-09-15",
      assigned: "Bowen Wang", created_at: ago(72), last_contact_at: ago(20), next_action_at: "", dnc: false,
      notes: [{ at: ago(20), by: "Bowen Wang", text: "Showing booked for 11:00 tomorrow." }] },
    { id: "ld_4", name: "Ahmed Farouk", phone: "587-555-0110", email: "a.farouk@example.com",
      source: "Kijiji", stage: "viewed", units: ["370-501"], beds: "1 bed", moveIn: "2026-08-15",
      assigned: "Bowen Wang", created_at: ago(120), last_contact_at: ago(60), next_action_at: "", dnc: false,
      notes: [{ at: ago(60), by: "Bowen Wang", text: "After the showing, wants to discuss with family." }] },
    { id: "ld_5", name: "Lily Kwan", phone: "780-555-0166", email: "lily.k@example.com",
      source: "Referral", stage: "applied", units: ["378-519"], beds: "2 bed", moveIn: "2026-08-01",
      assigned: "Bowen Wang", created_at: ago(200), last_contact_at: ago(5), next_action_at: "", dnc: false,
      notes: [{ at: ago(5), by: "Bowen Wang", text: "Details sent to the approval inbox." }] },
    { id: "ld_6", name: "Marcus Idowu", phone: "587-555-0198", email: "m.idowu@example.com",
      source: "WhatsApp", stage: "lost", units: [], beds: "1 bed", moveIn: "",
      assigned: "Bowen Wang", created_at: ago(300), last_contact_at: ago(150), next_action_at: "",
      lost_reason: "Not enough parking", dnc: false,
      notes: [{ at: ago(150), by: "Bowen Wang", text: "Needed an accessible stall; waitlist too long, went elsewhere." }] },
  ];
}

export default function CRM() {
  const [leads, setLeads] = useState(seedLeads);
  const [events, setEvents] = useState([]);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("pipeline");
  const [filter, setFilter] = useState("open");
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const today = isoD(new Date());

  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch (e) { return null; }
      };
      const l = await read("baydo:leads"); if (l) setLeads(l);
      const s = await read("baydo:schedule"); if (s?.events) setEvents(s.events);
      const ses = await read("baydo:session"); if (ses) setSession(ses);
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set("baydo:leads", JSON.stringify(next));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
  }, []);

  const save = (next) => { setLeads(next); persist(next); };
  const patch = (id, p) => save(leads.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const addNote = (id, text) => {
    if (!text.trim()) return;
    const l = leads.find((x) => x.id === id);
    patch(id, { notes: [...(l.notes || []), { at: nowISO(), by: session?.name || "unsigned", text: text.trim() }],
                last_contact_at: nowISO() });
  };

  const setStage = (id, stage) => {
    const p = { stage };
    if (stage !== "new") p.last_contact_at = nowISO();
    if (stage !== "lost") p.lost_reason = undefined;
    patch(id, p);
  };

  /* ---------- Filtering ---------- */
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter === "open" && !OPEN_STAGES.includes(l.stage)) return false;
      if (filter !== "open" && filter !== "all" && l.stage !== filter) return false;
      if (filter === "mine" && l.assigned !== session?.name) return false;
      if (!s) return true;
      return [l.name, l.phone, l.email, ...(l.units || [])].join(" ").toLowerCase().includes(s);
    });
  }, [leads, filter, q, session]);

  /* ---------- Overdue follow-ups ---------- */
  const overdue = useMemo(() => leads.filter((l) => {
    if (!OPEN_STAGES.includes(l.stage)) return false;
    const sla = ST[l.stage]?.sla;
    if (!sla) return false;
    const ref = l.last_contact_at || l.created_at;
    return hoursSince(ref) > sla;
  }), [leads]);

  /* ---------- Showing schedule ---------- */
  const showings = useMemo(() => {
    const list = events.filter((e) => e.type === "showing" && e.state === "booked")
                       .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const groups = {};
    list.forEach((e) => { (groups[e.date] ||= []).push(e); });
    return Object.entries(groups).sort();
  }, [events]);

  const upcoming = showings.filter(([d]) => d >= today);
  const past = showings.filter(([d]) => d < today).reverse();

  /* ---------- Funnel ---------- */
  const funnel = useMemo(() => {
    const counts = Object.fromEntries(STAGES.map((s) => [s.k, 0]));
    let respSum = 0, respN = 0;
    leads.forEach((l) => {
      counts[l.stage]++;
      if (l.last_contact_at && l.created_at) {
        respSum += (new Date(l.last_contact_at) - new Date(l.created_at)) / 3.6e6; respN++;
      }
    });
    const total = leads.length;
    const leased = counts.leased;
    const lostBy = {};
    leads.filter((l) => l.stage === "lost").forEach((l) => {
      const r = l.lost_reason || "Not recorded"; lostBy[r] = (lostBy[r] || 0) + 1;
    });
    const bySource = {};
    leads.forEach((l) => {
      const s = l.source || "Not recorded";
      bySource[s] ||= { total: 0, leased: 0 };
      bySource[s].total++;
      if (l.stage === "leased") bySource[s].leased++;
    });
    return { counts, total, leased,
             conv: total ? (leased / total) * 100 : 0,
             avgResp: respN ? respSum / respN : null,
             lostBy: Object.entries(lostBy).sort((a, b) => b[1] - a[1]),
             bySource: Object.entries(bySource).sort((a, b) => b[1].total - a[1].total) };
  }, [leads]);

  const selLead = leads.find((l) => l.id === sel);

  if (loading) return <div className="cr"><style>{CSS}</style><div className="cr-load">Loading leads…</div></div>;

  return (
    <div className="cr">
      <style>{CSS}</style>

      <header className="cr-head">
        <div>
          <div className="cr-eyebrow">Baydo Pointe · Leasing</div>
          <h1>Leads CRM</h1>
        </div>
        <div className="cr-headr">
          {session && <span className="cr-who">{session.name}</span>}
          <span className={`cr-save cr-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
          <button className="cr-btn" onClick={() => setAdding(!adding)}>New lead</button>
        </div>
      </header>

      <div className="cr-stats">
        <Stat l="Active" v={leads.filter((x) => OPEN_STAGES.includes(x.stage)).length} />
        <Stat l="Overdue" v={overdue.length} warn={overdue.length > 0} />
        <Stat l="Upcoming showings" v={upcoming.reduce((s, [, a]) => s + a.length, 0)} />
        <Stat l="Avg first reply" v={fmtH(funnel.avgResp)} small />
        <Stat l="Conversion" v={`${funnel.conv.toFixed(0)}%`} />
      </div>

      <nav className="cr-tabs">
        <button className={tab === "pipeline" ? "on" : ""} onClick={() => setTab("pipeline")}>
          Leads <i>{visible.length}</i>
        </button>
        <button className={tab === "showings" ? "on" : ""} onClick={() => setTab("showings")}>
          Showings <i>{upcoming.reduce((s, [, a]) => s + a.length, 0)}</i>
        </button>
        <button className={tab === "funnel" ? "on" : ""} onClick={() => setTab("funnel")}>Funnel</button>
        <button className={tab === "duplicates" ? "on" : ""} onClick={() => setTab("duplicates")}>
          Duplicates {dupes.length > 0 && <i className="cr-b">{dupes.length}</i>}
        </button>
      </nav>

      {adding && <AddLead existing={leads}
                          onAdd={(l) => { save([...leads, l]); setAdding(false); setSel(l.id); }}
                          onCancel={() => setAdding(false)} />}

      {/* ═══ Leads ═══ */}
      {tab === "duplicates" && (
        <div className="cr-body">
          <p className="cr-note">
            The same person enquires, applies, signs and renews, and ends up on file
            more than once. Merging keeps the oldest record — it holds the first
            contact date, which is what the response-time figures are measured from —
            and takes the furthest-along stage.
          </p>

          {dupes.length === 0 ? (
            <div className="cr-empty">Nobody is on file twice.</div>
          ) : dupes.map((d) => (
            <div className="cr-dup" key={d.key}>
              <div className="cr-dup-h">
                <strong>{d.keep.name}</strong>
                <span className="cr-dim">{d.key}</span>
                <span className="cr-tag">{d.merge.length + 1} records</span>
                <span className="cr-tag">would become “{d.stage}”</span>
              </div>
              <div className="cr-duprows">
                {[d.keep, ...d.merge].map((r, i) => (
                  <div className={`cr-duprow ${i === 0 ? "keep" : ""}`} key={r.id}>
                    <span className="cr-tag">{i === 0 ? "keep" : "fold in"}</span>
                    <span>{r.name}</span>
                    <span className="cr-dim">{r.stage}</span>
                    <span className="cr-dim">{r.source ?? "—"}</span>
                    <span className="cr-dim">
                      {String(r.created_at ?? "").slice(0, 10)}
                    </span>
                    <span className="cr-dim">{(r.notes ?? []).length} note(s)</span>
                  </div>
                ))}
              </div>
              <div className="cr-actions">
                <button className="cr-btn" onClick={() => mergeLeads(d)}>
                  Merge into one
                </button>
                <span className="cr-dim">
                  Notes move rather than being discarded — what somebody was told is
                  usually the useful part of an old record.
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "pipeline" && (
        <div className="cr-body">
          {overdue.length > 0 && (
            <div className="cr-alert">
              <strong>{overdue.length} overdue</strong>
              : {overdue.slice(0, 4).map((l) => l.name).join(", ")}{overdue.length > 4 ? " and others" : ""}.
              A new enquiry over 1 hour old, a contacted or viewed lead over 48 hours, or an application over 24 hours lands here.
            </div>
          )}

          <div className="cr-filters">
            <div className="cr-chips">
              {[["open", "Active"], ["mine", "Mine"], ...STAGES.map((s) => [s.k, s.label]), ["all", "All"]]
                .map(([k, l]) => (
                <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <input className="cr-in cr-search" value={q} placeholder="Search name, phone, email, unit…"
                   onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="cr-list">
            {visible.length === 0 && <div className="cr-empty">No leads match.</div>}
            {visible.map((l) => {
              const s = ST[l.stage];
              const ref = l.last_contact_at || l.created_at;
              const h = hoursSince(ref);
              const late = OPEN_STAGES.includes(l.stage) && s.sla && h > s.sla;
              return (
                <button key={l.id} className={`cr-lead ${sel === l.id ? "on" : ""} ${late ? "late" : ""}`}
                        style={{ "--c": s.color }} onClick={() => setSel(sel === l.id ? null : l.id)}>
                  <div className="cr-lead-h">
                    <span className="cr-stage" style={{ "--c": s.color }}>{s.label}</span>
                    <strong>{l.name}</strong>
                    {l.dnc && <span className="cr-dnc">Do not contact</span>}
                    <span className="cr-ago">{late ? "overdue · " : ""}{fmtH(h)} idle</span>
                  </div>
                  <div className="cr-lead-b">
                    {l.units?.length > 0 && (
                      <span className="cr-mono">
                        {l.units.join("、")}
                        {unitType(l.units[0]) && ` · ${unitType(l.units[0])}`}
                      </span>
                    )}
                    {l.beds && <span className="cr-tag">{l.beds}</span>}
                    <a className="cr-c" href={`tel:${l.phone}`} onClick={(e) => e.stopPropagation()}>{l.phone}</a>
                    <a className="cr-c" href={`mailto:${l.email}`} onClick={(e) => e.stopPropagation()}>{l.email}</a>
                    <span className="cr-dim">{l.source}</span>
                    {l.assigned && <span className="cr-dim">· {l.assigned}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {selLead && (
            <LeadDetail lead={selLead} session={session}
                        onPatch={(p) => patch(selLead.id, p)}
                        onStage={(s) => setStage(selLead.id, s)}
                        onNote={(t) => addNote(selLead.id, t)}
                        onClose={() => setSel(null)} />
          )}
        </div>
      )}

      {/* ═══ Showings ═══ */}
      {tab === "showings" && (
        <div className="cr-body">
          <p className="cr-note">
            This reads from the schedule tool. Here you see which unit to show and when;
            the schedule tool shows the whole day and handles reminders.
          </p>

          <section className="cr-card">
            <h2>Upcoming <span className="cr-n">{upcoming.reduce((s, [, a]) => s + a.length, 0)}</span></h2>
            {upcoming.length === 0 ? (
              <div className="cr-empty">No showings booked.</div>
            ) : upcoming.map(([date, list]) => {
              const rel = date === today ? "Today" : date === addD(today, 1) ? "Tomorrow"
                        : `in ${Math.round((parseD(date) - parseD(today)) / 864e5)} days`;
              return (
                <div className="cr-day" key={date}>
                  <div className="cr-dayh">
                    <strong>{pretty(date)}</strong>
                    <span className={date === today ? "cr-today" : "cr-dim"}>{rel}</span>
                    <span className="cr-dim">{list.length}</span>
                  </div>
                  {list.map((e) => {
                    const t = unitType(e.unit);
                    return (
                      <div className="cr-show" key={e.id}>
                        <span className="cr-time">{e.time}</span>
                        <span className="cr-mono cr-unit">{e.unit}</span>
                        {t && <><span className="cr-mono cr-type">{t}</span>
                                <span className="cr-tag">{BED[t]}</span></>}
                        <strong className="cr-nm">{e.name}</strong>
                        <a className="cr-c" href={`tel:${e.contact}`}>{e.contact}</a>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </section>

          {past.length > 0 && (
            <section className="cr-card">
              <h2>Past showings <span className="cr-n">{past.reduce((s, [, a]) => s + a.length, 0)}</span></h2>
              <p className="cr-note">
                A showing with no follow-up within 48 hours is flagged overdue on the leads list.
              </p>
              {past.slice(0, 5).map(([date, list]) => (
                <div className="cr-day cr-day--past" key={date}>
                  <div className="cr-dayh"><strong>{pretty(date)}</strong><span className="cr-dim">{list.length}</span></div>
                  {list.map((e) => (
                    <div className="cr-show" key={e.id}>
                      <span className="cr-time">{e.time}</span>
                      <span className="cr-mono cr-unit">{e.unit}</span>
                      <strong className="cr-nm">{e.name}</strong>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {/* ═══ Funnel ═══ */}
      {tab === "funnel" && (
        <div className="cr-body">
          <section className="cr-card">
            <h2>Conversion funnel</h2>
            <p className="cr-note">{funnel.total} leads, {funnel.leased} leased.</p>
            <div className="cr-funnel">
              {STAGES.filter((s) => s.k !== "lost").map((s) => {
                const n = funnel.counts[s.k];
                const pct = funnel.total ? (n / funnel.total) * 100 : 0;
                return (
                  <div className="cr-fr" key={s.k}>
                    <span className="cr-fl">{s.label}</span>
                    <div className="cr-fbar"><i style={{ width: `${pct}%`, background: s.color }} /></div>
                    <span className="cr-mono cr-fn">{n}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="cr-card">
            <h2>By source</h2>
            <div className="cr-table">
              <div className="cr-tr cr-tr--h"><span>Source</span><span>Leads</span><span>Leased</span><span>Rate</span></div>
              {funnel.bySource.map(([s, d]) => (
                <div className="cr-tr" key={s}>
                  <span>{s}</span>
                  <span className="cr-mono">{d.total}</span>
                  <span className="cr-mono">{d.leased}</span>
                  <span className="cr-mono">{d.total ? ((d.leased / d.total) * 100).toFixed(0) : 0}%</span>
                </div>
              ))}
            </div>
            <p className="cr-note">
              These rates mean little on small samples. Wait until a source has thirty or so leads before letting it drive budget.
            </p>
          </section>

          <section className="cr-card">
            <h2>Why leads were lost</h2>
            {funnel.lostBy.length === 0 ? <div className="cr-empty">No lost leads recorded.</div> : (
              <div className="cr-table">
                {funnel.lostBy.map(([r, n]) => (
                  <div className="cr-tr" key={r} style={{ gridTemplateColumns: "1fr 60px" }}>
                    <span>{r}</span><span className="cr-mono">{n}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="cr-note">
              If "Not enough parking" keeps climbing, that is not a sales problem. It is the 108-stall shortfall, and the fix is in the allocation policy.
            </p>
          </section>
        </div>
      )}

      <footer className="cr-foot">
        Lead records are personal information under Alberta PIPA: collect only what you need, set a retention period, and purge leads that never converted once it expires.
        Anyone marked Do not contact must receive no further marketing messages (CASL).
        Never rank or prioritise leads by income source, family status, nationality or any other protected ground.
      </footer>
    </div>
  );
}

/* ============================ Sub-components ============================ */

function Stat({ l, v, warn, small }) {
  return (
    <div className="cr-stat">
      <div className="cr-stat-l">{l}</div>
      <div className={`cr-stat-v ${warn ? "warn" : ""} ${small ? "sm" : ""}`}>{v}</div>
    </div>
  );
}

function AddLead({ onAdd, onCancel, existing }) {
  const [f, setF] = useState({ name: "", phone: "", email: "", source: SOURCES[0], units: "", beds: "", moveIn: "" });
  const [override, setOverride] = useState("");
  const set = (k, v) => setF({ ...f, [k]: v });

  // Checked as it is typed, so a duplicate is caught at the email field rather
  // than after the whole form is filled in.
  const check = useMemo(
    () => (f.email || f.phone || f.name)
      ? screenLead({ email: f.email, phone: f.phone, name: f.name }, existing)
      : { result: "clear" },
    [f.email, f.phone, f.name, existing]);

  const blocked = check.result === "duplicate";
  const needsNote = check.result === "review";
  const canAdd = f.name.trim() && !blocked && (!needsNote || override.trim());

  return (
    <div className="cr-add">
      <input className="cr-in" placeholder="Name" value={f.name} onChange={(e) => set("name", e.target.value)} />
      <input className="cr-in" placeholder="Phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
      <input className="cr-in" placeholder="Email" value={f.email} onChange={(e) => set("email", e.target.value)} />
      <select className="cr-sel" value={f.source} onChange={(e) => set("source", e.target.value)}>
        {SOURCES.map((s) => <option key={s}>{s}</option>)}
      </select>
      <input className="cr-in" placeholder="Units of interest, e.g. 370-412" value={f.units}
             onChange={(e) => set("units", e.target.value)} />
      <input className="cr-in" type="date" value={f.moveIn} onChange={(e) => set("moveIn", e.target.value)} />
      {blocked && (
        <div className="cr-block">
          <strong>Already on file.</strong> {check.detail}
          <span> The same contact details cannot be registered twice.</span>
        </div>
      )}

      {needsNote && (
        <div className="cr-review">
          <strong>Looks like an existing record.</strong> {check.detail}
          <p>
            This is a resemblance, not a match, so it is your call. People do share
            names, and refusing someone on that basis alone is not something the
            system will do on its own. Say what you checked.
          </p>
          <input className="cr-in" value={override}
                 placeholder="Different person — spoke to both, different addresses"
                 onChange={(e) => setOverride(e.target.value)} />
        </div>
      )}

      <button className="cr-btn" disabled={!canAdd}
              onClick={() => onAdd({ id: uid(), name: f.name.trim(), phone: f.phone.trim(),
                email: f.email.trim(), source: f.source, stage: "new",
                units: f.units.trim() ? f.units.split(/[,、\s]+/).filter(Boolean) : [],
                beds: f.beds, moveIn: f.moveIn, assigned: "", created_at: nowISO(),
                last_contact_at: null, next_action_at: "", dnc: false,
                screen: needsNote ? { ...check, match: check.match?.id ?? null,
                  decided_note: override.trim(), decided_at: nowISO() } : null,
                notes: needsNote ? [{ at: nowISO(), by: "screening",
                  text: `Flagged as similar to an existing record and allowed: ${override.trim()}` }] : [] })}>
        Create
      </button>
      <button className="cr-btn cr-btn--ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function LeadDetail({ lead, session, onPatch, onStage, onNote, onClose }) {
  const [note, setNote] = useState("");
  return (
    <div className="cr-detail">
      <div className="cr-dh">
        <strong>{lead.name}</strong>
        <span className="cr-dim">Created {lead.created_at?.slice(0, 16).replace("T", " ")}</span>
        <button className="cr-x" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="cr-stagebar">
        {STAGES.map((s) => (
          <button key={s.k} className={lead.stage === s.k ? "on" : ""}
                  style={{ "--c": s.color }} onClick={() => onStage(s.k)}>{s.label}</button>
        ))}
      </div>

      {lead.stage === "lost" && (
        <label className="cr-f">
          <span>Reason lost</span>
          <select className="cr-sel" value={lead.lost_reason || ""}
                  onChange={(e) => onPatch({ lost_reason: e.target.value })}>
            <option value="">Choose one</option>
            {LOST_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
      )}

      <div className="cr-drow">
        <label className="cr-f"><span>Units of interest</span>
          <input className="cr-in" value={(lead.units || []).join("、")}
                 placeholder="370-412、378-519"
                 onChange={(e) => onPatch({ units: e.target.value.split(/[,、\s]+/).filter(Boolean) })} /></label>
        <label className="cr-f"><span>Target move-in</span>
          <input className="cr-in" type="date" value={lead.moveIn || ""}
                 onChange={(e) => onPatch({ moveIn: e.target.value })} /></label>
        <label className="cr-f"><span>Owner</span>
          <input className="cr-in" value={lead.assigned || ""} placeholder={session?.name || "Unassigned"}
                 onChange={(e) => onPatch({ assigned: e.target.value })} /></label>
        <label className="cr-f"><span>Next follow-up</span>
          <input className="cr-in" type="date" value={lead.next_action_at || ""}
                 onChange={(e) => onPatch({ next_action_at: e.target.value })} /></label>
      </div>

      <label className="cr-dnctoggle">
        <input type="checkbox" checked={!!lead.dnc}
               onChange={(e) => onPatch({ dnc: e.target.checked })} />
        <span>Do not contact (CASL opt-out) — no marketing messages once ticked</span>
      </label>

      <div className="cr-notes">
        <div className="cr-noteh">Contact history</div>
        {(lead.notes || []).length === 0 && <div className="cr-empty">Nothing recorded yet.</div>}
        {(lead.notes || []).slice().reverse().map((n, i) => (
          <div className="cr-note-i" key={i}>
            <div className="cr-dim">{n.at?.slice(0, 16).replace("T", " ")} · {n.by}</div>
            <p>{n.text}</p>
          </div>
        ))}
        <div className="cr-noteadd">
          <input className="cr-in" value={note} placeholder="Log a contact…"
                 onChange={(e) => setNote(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { onNote(note); setNote(""); } }} />
          <button className="cr-btn cr-btn--sm" onClick={() => { onNote(note); setNote(""); }}
                  disabled={!note.trim()}>Log</button>
        </div>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.cr{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.cr *{box-sizing:border-box}
.cr-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.cr-dim{color:var(--dim);font-size:12px}
.cr-load{padding:80px 20px;text-align:center;color:var(--dim)}

.cr-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.cr-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.cr-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.cr-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cr-who{font-size:12.5px;font-weight:600}
.cr-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.cr-save--saved{color:var(--green);border-color:var(--green)}
.cr-save--error{color:var(--red);border-color:var(--red)}

.cr-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 15px;border-radius:3px}
.cr-btn:hover:not(:disabled){background:#000}
.cr-btn:disabled{opacity:.4;cursor:not-allowed}
.cr-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.cr-btn--sm{padding:6px 12px;font-size:12px}
.cr-btn:focus-visible,.cr-in:focus-visible,.cr-sel:focus-visible,.cr-lead:focus-visible,
.cr-tabs button:focus-visible,.cr-chips button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.cr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));background:var(--paper);
  border-bottom:1px solid var(--rule)}
.cr-stat{padding:13px 28px;border-right:1px solid var(--rule)}
.cr-stat:last-child{border-right:0}
.cr-stat-l{font-size:10.5px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.cr-stat-v{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;margin-top:2px}
.cr-stat-v.sm{font-size:15px;padding-top:4px}
.cr-stat-v.warn{color:var(--red)}

.cr-tabs{display:flex;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--rule)}
.cr-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 18px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:7px}
.cr-tabs button.on{color:var(--ink);border-bottom-color:var(--brand,var(--ink))}
.cr-tabs i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10.5px;
  background:var(--ground);border-radius:8px;padding:1px 7px;color:var(--ink2)}

.cr-body{padding:18px 28px;display:flex;flex-direction:column;gap:14px;max-width:1200px}
.cr-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px}
.cr-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0 0 4px;
  display:flex;align-items:center;gap:8px}
.cr-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.cr-note{color:var(--dim);font-size:12.5px;margin:6px 0 12px;line-height:1.65}
.cr-empty{color:var(--dim);font-size:12.5px;padding:18px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

.cr-alert{background:#FDF6F7;border:1px solid var(--red);border-radius:4px;padding:11px 14px;
  font-size:12.5px;color:var(--ink2);line-height:1.65}
.cr-alert strong{color:var(--red)}

.cr-add{display:flex;gap:8px;flex-wrap:wrap;padding:14px 28px;background:var(--paper);
  border-bottom:1px solid var(--rule)}
.cr-add .cr-in{flex:1 1 130px}
.cr-in,.cr-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%;min-width:0}
.cr-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}

.cr-filters{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.cr-chips{display:flex;gap:5px;flex-wrap:wrap}
.cr-chips button{font:inherit;font-size:12px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:14px;padding:4px 12px;color:var(--dim)}
.cr-chips button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.cr-search{max-width:280px;flex:1 1 180px;width:auto}

.cr-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:4px;overflow:hidden}
.cr-lead{font:inherit;text-align:left;cursor:pointer;background:var(--paper);border:0;
  border-left:3px solid var(--c);padding:10px 13px;display:flex;flex-direction:column;gap:3px}
.cr-lead:hover{background:#F6F9FB}
.cr-lead.on{background:#F2F7FB}
.cr-lead.late{background:#FFFCFC}
.cr-lead-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-lead-h strong{font-size:13.5px}
.cr-stage{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;padding:1px 8px}
.cr-dnc{font-size:10px;font-weight:700;color:var(--red);border:1px solid var(--red);border-radius:9px;
  padding:1px 7px}
.cr-ago{margin-left:auto;font-size:11px;color:var(--dim);font-family:'IBM Plex Mono',monospace}
.cr-lead.late .cr-ago{color:var(--red);font-weight:600}
.cr-lead-b{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--ink2)}
.cr-tag{font-size:10.5px;border:1px solid var(--rule);border-radius:9px;padding:1px 8px;color:var(--ink2)}
.cr-c{font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--ink2);text-decoration:none;
  border-bottom:1px dotted var(--dim)}
.cr-c:hover{color:var(--accent);border-bottom-color:var(--accent)}

.cr-detail{background:var(--paper);border:1px solid var(--accent);border-radius:4px;padding:16px 18px;
  display:flex;flex-direction:column;gap:12px}
.cr-dh{display:flex;align-items:baseline;gap:10px}
.cr-dh strong{font-size:16px}
.cr-x{margin-left:auto;font-size:20px;line-height:1;cursor:pointer;background:none;border:0;
  color:var(--dim);padding:0 4px}
.cr-x:hover{color:var(--ink)}
.cr-stagebar{display:flex;gap:4px;flex-wrap:wrap}
.cr-stagebar button{font:inherit;font-size:12px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:6px 12px;color:var(--dim)}
.cr-stagebar button.on{background:var(--c);color:#fff;border-color:var(--c);font-weight:600}
.cr-drow{display:flex;gap:12px;flex-wrap:wrap}
.cr-drow>*{flex:1 1 150px}
.cr-f{display:flex;flex-direction:column;gap:5px}
.cr-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.cr-dnctoggle{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink2)}

.cr-notes{border-top:1px solid var(--rule);padding-top:12px;display:flex;flex-direction:column;gap:8px}
.cr-noteh{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--dim)}
.cr-note-i{border-left:2px solid var(--rule);padding-left:10px}
.cr-note-i p{margin:2px 0 0;font-size:13px;line-height:1.6}
.cr-noteadd{display:flex;gap:8px}
.cr-noteadd .cr-in{flex:1}

/* Showings */
.cr-day{margin-bottom:14px}
.cr-day--past{opacity:.6}
.cr-dayh{display:flex;align-items:baseline;gap:10px;padding-bottom:5px;border-bottom:1px solid var(--rule);
  margin-bottom:6px;font-size:13px}
.cr-today{font-size:11.5px;font-weight:700;color:#fff;background:var(--accent);border-radius:9px;
  padding:1px 9px}
.cr-show{display:flex;align-items:center;gap:10px;padding:7px 0;flex-wrap:wrap;
  border-bottom:1px dotted var(--rule);font-size:13px}
.cr-show:last-child{border-bottom:0}
.cr-time{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;flex:0 0 48px}
.cr-unit{font-size:13.5px;font-weight:600}
.cr-type{font-size:12px;color:var(--accent);font-weight:600}
.cr-nm{font-size:13px}
.cr-show .cr-c{margin-left:auto}

/* Funnel */
.cr-funnel{display:flex;flex-direction:column;gap:7px;margin-top:10px}
.cr-fr{display:grid;grid-template-columns:80px 1fr 40px;gap:10px;align-items:center;font-size:12.5px}
.cr-fbar{height:16px;background:var(--ground);border-radius:2px;overflow:hidden}
.cr-fbar i{display:block;height:100%}
.cr-fn{text-align:right}
.cr-table{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden;margin-top:10px}
.cr-tr{display:grid;grid-template-columns:1fr 70px 70px 80px;gap:10px;padding:7px 12px;
  background:var(--paper);font-size:12.5px}
.cr-tr--h{background:var(--ground);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dim);font-family:'IBM Plex Mono',monospace}

.cr-block{flex:1 1 100%;font-size:12.5px;color:var(--red);background:#FDF6F7;
  border:1px solid var(--red);border-radius:3px;padding:10px 13px;line-height:1.65}
.cr-review{flex:1 1 100%;font-size:12.5px;color:#7A5D14;background:var(--amber);
  border:1px solid var(--amberline);border-radius:3px;padding:10px 13px;line-height:1.65;
  display:flex;flex-direction:column;gap:6px}
.cr-review p{margin:0;line-height:1.7}
.cr-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;
  background:#C98A15;color:#fff;border-radius:8px;padding:1px 6px;margin-left:5px}
.cr-dup{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:13px 15px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px}
.cr-dup-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13.5px}
.cr-duprows{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.cr-duprow{display:grid;grid-template-columns:70px 1fr 90px 1fr 90px 80px;gap:9px;
  padding:7px 11px;background:var(--paper);font-size:12.5px;align-items:center}
.cr-duprow.keep{background:#FCFDFE;font-weight:600}
.cr-empty{color:var(--dim);font-size:12.5px;padding:30px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px;background:var(--paper)}
.cr-note{color:var(--dim);font-size:12.5px;line-height:1.7;max-width:74ch;margin:0 0 12px}
.cr-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:90ch;line-height:1.7}

@media (max-width:760px){
  .cr-head,.cr-tabs,.cr-body,.cr-add,.cr-foot{padding-left:16px;padding-right:16px}
  .cr-stat{padding:11px 16px}
  .cr-show .cr-c{margin-left:0;width:100%}
}
`;
