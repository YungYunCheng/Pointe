import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — agreement library

   The system does not produce an agreement. Admin uploads the file
   a lawyer approved, and that file is what reaches the tenant, byte
   for byte. Nothing merges values into it or regenerates it.

   The reason is narrow: a generated clause can be void, and it reads
   exactly as convincingly as a valid one. The only way to be certain
   the tenant signed what counsel approved is for those to be the
   same file.

   What this screen does instead is keep track — which version is
   live, who approved it, and which version went to which tenant.
   That is the question asked in a dispute, and a generated document
   cannot answer it.
   ============================================================ */

const STATE = {
  uploaded:   { label: "Waiting for approval", color: "#C98A15" },
  approved:   { label: "Live",                 color: "#0E8577" },
  superseded: { label: "Superseded",           color: "#8892A0" },
  withdrawn:  { label: "Withdrawn",            color: "#B23A54" },
};

/* Where a signature request has got to. "Viewed" matters more than it looks:
   a tenant who opened the link three days ago and has not signed usually has
   a question, not a busy week. */
const SIG_STATE = {
  draft:     { label: "Not sent",  color: "#8892A0" },
  sent:      { label: "Sent",      color: "#1C6FA6" },
  viewed:    { label: "Opened",    color: "#C98A15" },
  signed:    { label: "Partly signed", color: "#7C5CBF" },
  completed: { label: "Complete",  color: "#0E8577" },
  declined:  { label: "Declined",  color: "#B23A54" },
  expired:   { label: "Expired",   color: "#8892A0" },
  voided:    { label: "Voided",    color: "#8892A0" },
};

const ISSUE_STATE = {
  prepared:  { label: "Prepared",  color: "#8892A0" },
  sent:      { label: "Sent",      color: "#1C6FA6" },
  signed:    { label: "Signed",    color: "#0E8577" },
  declined:  { label: "Declined",  color: "#B23A54" },
  cancelled: { label: "Cancelled", color: "#8892A0" },
};

/* The set an Alberta rental needs. Seeded empty on purpose: an empty library
   should look empty, so nobody finds out on the day they need a lease. */
const SEED = [
  { code: "lease", name: "Residential Tenancy Agreement", zh: "住宅租約", order: 10,
    note: "The main lease. Nothing downstream can complete without an approved version." },
  { code: "parking", name: "Parking Agreement", zh: "車位使用協議", order: 20,
    note: "Separate from the lease so a stall can be given up without reopening the tenancy." },
  { code: "storage", name: "Storage Locker Agreement", zh: "儲藏室協議", order: 30 },
  { code: "pet", name: "Pet Addendum", zh: "寵物附約", order: 40,
    note: "Service animals are not pets. This does not apply to them." },
  { code: "inspection_in", name: "Move-in Inspection Report", zh: "入住檢查報告", order: 50,
    note: "Required in Alberta. Without it a deposit dispute is hard to defend." },
  { code: "inspection_out", name: "Move-out Inspection Report", zh: "遷出檢查報告", order: 60 },
  { code: "deposit_receipt", name: "Security Deposit Receipt", zh: "保證金收據", order: 70,
    note: "The deposit is held in trust; the receipt states where." },
  { code: "keys", name: "Key and Fob Acknowledgement", zh: "鑰匙與門禁卡簽收單", order: 80 },
  { code: "renewal", name: "Renewal Notice", zh: "續約通知", order: 90 },
  { code: "termination", name: "Notice of Termination", zh: "終止通知", order: 100,
    note: "Notice periods come from the RTA. Have this one checked carefully." },
  { code: "emergency_contact", name: "Emergency Contact Form", zh: "緊急聯絡資料表", order: 110 },
].map((a) => ({ id: "ag_" + a.code, ...a, versions: [] }));

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const stamp = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "—");
const kb = (n) => (n == null ? "—" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB`
                                                 : `${Math.round(n / 1024)} KB`);
const money = (n) => (n == null || isNaN(n) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));

/** Hashing in the browser so the same file uploaded twice under two labels is
 *  caught as what it is: a filing mistake, not two versions. */
async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function Agreements() {
  const [session, setSession] = useState(undefined);
  const [agreements, setAgreements] = useState(SEED);
  const [issues, setIssues] = useState([]);
  const [tab, setTab] = useState("library");
  const [signatures, setSignatures] = useState([]);
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  const isAdmin = session?.role === "admin";
  const canIssue = ["admin", "property_manager"].includes(session?.role);

  useEffect(() => {
    (async () => {
      const read = async (k, d) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : d; }
        catch { return d; }
      };
      setSession(await read("baydo:session", null));
      const saved = await read("baydo:agreements", null);
      // Merge rather than replace: a slot added in a later release should
      // appear without wiping what has already been uploaded.
      if (saved) {
        const bySlot = Object.fromEntries(saved.map((a) => [a.code, a]));
        setAgreements(SEED.map((s) => bySlot[s.code] ? { ...s, ...bySlot[s.code] } : s)
          .concat(saved.filter((a) => !SEED.some((s) => s.code === a.code))));
      }
      setIssues(await read("baydo:agreementissues", []));
      setSignatures(await read("baydo:signatures", []));
      setLoading(false);
    })();
  }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };

  const saveAgreements = useCallback(async (next) => {
    setAgreements(next);
    try { await window.storage.set("baydo:agreements", JSON.stringify(next)); } catch {}
  }, []);
  const saveIssues = useCallback(async (next) => {
    setIssues(next);
    try { await window.storage.set("baydo:agreementissues", JSON.stringify(next)); } catch {}
  }, []);
  const saveSignatures = useCallback(async (next) => {
    setSignatures(next);
    try { await window.storage.set("baydo:signatures", JSON.stringify(next)); } catch {}
  }, []);

  const readiness = useMemo(() => {
    const live = agreements.filter((a) => a.versions?.some((v) => v.state === "approved"));
    const missing = agreements.filter((a) => !a.versions?.some((v) => v.state === "approved"));
    return { live: live.length, total: agreements.length, missing,
             leaseReady: !!agreements.find((a) => a.code === "lease")
               ?.versions?.some((v) => v.state === "approved") };
  }, [agreements]);

  const selected = agreements.find((a) => a.id === sel);

  if (loading || session === undefined)
    return <div className="ag"><style>{CSS}</style><div className="ag-load">Loading…</div></div>;

  return (
    <div className="ag">
      <style>{CSS}</style>

      <header className="ag-head">
        <div>
          <div className="ag-eyebrow">Baydo Pointe · Agreements</div>
          <h1>Agreement library</h1>
        </div>
        <div className="ag-headr">
          <span className="ag-ready">
            {readiness.live} of {readiness.total} ready
          </span>
          {session && (
            <span className="ag-chip" style={{ background: isAdmin ? "#131C25" : "#1C6FA6" }}>
              {isAdmin ? "Admin" : "Property Manager"}
            </span>
          )}
        </div>
      </header>

      <nav className="ag-tabs">
        <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
          Library
        </button>
        <button className={tab === "issued" ? "on" : ""} onClick={() => setTab("issued")}>
          Issued {issues.length > 0 && <i>{issues.length}</i>}
        </button>
        <button className={tab === "signing" ? "on" : ""} onClick={() => setTab("signing")}>
          Signing {signatures.filter((s) => !["completed", "voided", "declined"]
            .includes(s.state)).length > 0 &&
            <i>{signatures.filter((s) => !["completed", "voided", "declined"]
              .includes(s.state)).length}</i>}
        </button>
      </nav>

      {/* The one that stops everything. Worth saying plainly rather than
          letting somebody discover it during a signing. */}
      {!readiness.leaseReady && (
        <div className="ag-block">
          <strong>No lease has been uploaded.</strong>
          <span>
            {isAdmin
              ? " Nothing can be signed until you upload an approved Residential Tenancy Agreement and mark it live."
              : " Nothing can be signed until Admin uploads an approved Residential Tenancy Agreement."}
          </span>
        </div>
      )}

      {msg && <div className="ag-flash">{msg}</div>}

      {tab === "library" && (
        <div className="ag-body">
          <div className="ag-split">
            <aside className="ag-list">
              <div className="ag-note">
                {isAdmin
                  ? "Upload the file your lawyer approved. It is stored and sent exactly as uploaded — nothing here rewrites, reflows or generates an agreement."
                  : "These are the agreements Admin has approved. Send one to a tenant and the file they receive is the file counsel signed off, unchanged."}
              </div>
              {agreements.sort((a, b) => a.order - b.order).map((a) => {
                const live = a.versions?.find((v) => v.state === "approved");
                return (
                  <button key={a.id} className={`ag-item ${sel === a.id ? "on" : ""}`}
                          onClick={() => setSel(a.id)}>
                    <span className="ag-item-n">{a.name}</span>
                    <span className="ag-item-m">
                      {live
                        ? <><i className="ag-dot ag-dot--ok" />{live.version_label}</>
                        : <><i className="ag-dot" />
                            {a.versions?.length ? "not approved" : "nothing uploaded"}</>}
                    </span>
                  </button>
                );
              })}
            </aside>

            <section className="ag-detail">
              {!selected ? (
                <div className="ag-empty">Pick an agreement on the left.</div>
              ) : (
                <AgreementDetail
                  agreement={selected} isAdmin={isAdmin} canIssue={canIssue} session={session}
                  onSave={(next) => saveAgreements(agreements.map((a) =>
                    a.id === next.id ? next : a))}
                  onIssue={(rec) => { saveIssues([rec, ...issues]); setTab("issued");
                                      flash(`Prepared for ${rec.tenant_name}.`); }}
                  flash={flash} />
              )}
            </section>
          </div>
        </div>
      )}

      {tab === "signing" && (
        <Signing signatures={signatures} agreements={agreements} canIssue={canIssue}
                 session={session} onSave={saveSignatures} flash={flash} />
      )}

      {tab === "issued" && (
        <Issued issues={issues} agreements={agreements} canIssue={canIssue}
                onSave={saveIssues} flash={flash} />
      )}

      <footer className="ag-foot">
        Every version is kept. Approving one supersedes the last rather than replacing it,
        so the file a tenant signed in March is still retrievable in March’s form. The hash
        beside each version identifies exactly which bytes were sent — a copy that does not
        match it is not the copy that went out.
      </footer>
    </div>
  );
}

/* ══════════════════ Detail ══════════════════ */

function AgreementDetail({ agreement, isAdmin, canIssue, session, onSave, onIssue, flash }) {
  const [uploading, setUploading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const versions = (agreement.versions ?? [])
    .slice().sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  const live = versions.find((v) => v.state === "approved");

  const approve = (v) => {
    const next = { ...agreement, versions: versions.map((x) =>
      x.id === v.id ? { ...x, state: "approved", approved_by: session?.name,
                        approved_at: nowISO() }
      : x.state === "approved" ? { ...x, state: "superseded" } : x) };
    onSave(next);
    flash(`${v.version_label} is now live.`);
  };

  const withdraw = (v, reason) => {
    onSave({ ...agreement, versions: versions.map((x) =>
      x.id === v.id ? { ...x, state: "withdrawn", withdrawn_reason: reason } : x) });
    flash(`${v.version_label} withdrawn.`);
  };

  return (
    <>
      <div className="ag-dh">
        <div>
          <h2>{agreement.name}</h2>
          <span className="ag-dim">{agreement.zh}</span>
        </div>
        <div className="ag-dh-r">
          {isAdmin && (
            <button className="ag-btn ag-btn--sm" onClick={() => setUploading(!uploading)}>
              Upload a version
            </button>
          )}
          {canIssue && live && (
            <button className="ag-btn ag-btn--sm" onClick={() => setIssuing(!issuing)}>
              Send to a tenant
            </button>
          )}
        </div>
      </div>

      {agreement.note && <p className="ag-caution">{agreement.note}</p>}

      {uploading && isAdmin && (
        <UploadVersion existing={versions}
          onAdd={(v) => { onSave({ ...agreement, versions: [v, ...versions] });
                          setUploading(false);
                          flash("Uploaded. It is not usable until you mark it live."); }}
          onCancel={() => setUploading(false)} />
      )}

      {issuing && live && (
        <IssueForm agreement={agreement} version={live} session={session}
          onIssue={(rec) => { onIssue(rec); setIssuing(false); }}
          onCancel={() => setIssuing(false)} />
      )}

      {versions.length === 0 ? (
        <div className="ag-empty">
          {isAdmin
            ? "Nothing uploaded. Add the version your lawyer approved."
            : "Admin has not uploaded this one yet."}
        </div>
      ) : (
        <div className="ag-versions">
          {versions.map((v) => (
            <VersionRow key={v.id} v={v} isAdmin={isAdmin}
                        onApprove={() => approve(v)} onWithdraw={(r) => withdraw(v, r)} />
          ))}
        </div>
      )}
    </>
  );
}

function VersionRow({ v, isAdmin, onApprove, onWithdraw }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const st = STATE[v.state] ?? STATE.uploaded;

  return (
    <div className={`ag-version ${v.state === "approved" ? "live" : ""}`}>
      <div className="ag-version-h">
        <span className="ag-tag" style={{ "--c": st.color }}>{st.label}</span>
        <strong>{v.version_label}</strong>
        <span className="ag-dim ag-cut">{v.filename}</span>
        <span className="ag-dim ag-mono">{kb(v.size_bytes)}</span>
      </div>

      <div className="ag-dim">
        Uploaded {stamp(v.uploaded_at)} by {v.uploaded_by ?? "—"}
        {v.approved_at && <> · approved {stamp(v.approved_at)} by {v.approved_name ?? "—"}</>}
        {v.effective_from && <> · effective {v.effective_from}</>}
      </div>

      {v.approval_note && <div className="ag-vnote">{v.approval_note}</div>}
      {v.withdrawn_reason && (
        <div className="ag-vnote ag-vnote--bad">Withdrawn: {v.withdrawn_reason}</div>
      )}

      {/* The hash is what makes "this is the file that went out" checkable. */}
      <div className="ag-hash">{v.sha256}</div>

      <div className="ag-actions">
        <button className="ag-btn ag-btn--xs ag-btn--ghost"
                onClick={() => downloadVersion(v)}>Download</button>
        {isAdmin && v.state === "uploaded" && (
          <button className="ag-btn ag-btn--xs" onClick={onApprove}>Mark live</button>
        )}
        {isAdmin && v.state !== "withdrawn" && (
          confirming ? (
            <span className="ag-inline">
              <input className="ag-in ag-in--sm" value={reason} placeholder="Why withdraw it?"
                     onChange={(e) => setReason(e.target.value)} />
              <button className="ag-btn ag-btn--xs" disabled={!reason.trim()}
                      onClick={() => { onWithdraw(reason.trim()); setConfirming(false); }}>
                Withdraw
              </button>
              <button className="ag-btn ag-btn--xs ag-btn--ghost"
                      onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          ) : (
            <button className="ag-btn ag-btn--xs ag-btn--ghost"
                    onClick={() => setConfirming(true)}>Withdraw</button>
          )
        )}
      </div>

      {v.state === "approved" && (
        <p className="ag-live-note">
          This is the version that goes out. Approving another supersedes it —
          there is one live version at a time, which is what stops two tenants
          signing two different leases in the same week.
        </p>
      )}
    </div>
  );
}

function downloadVersion(v) {
  // Against the API this hits /agreements/versions/:id/file, which streams the
  // stored bytes untouched. Standalone there is nothing to serve, so the
  // metadata is offered instead of a file that would not be the real one.
  if (v.data_url) {
    const a = document.createElement("a");
    a.href = v.data_url; a.download = v.filename; a.click();
    return;
  }
  const blob = new Blob([JSON.stringify({ note: "Metadata only — the stored file is served by the API.",
    version: v.version_label, filename: v.filename, sha256: v.sha256 }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${v.filename}.metadata.json`; a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════ Upload ══════════════════ */

function UploadVersion({ existing, onAdd, onCancel }) {
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState("");
  const [effective, setEffective] = useState("");
  const [note, setNote] = useState("");
  const [hash, setHash] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async (f) => {
    setErr(""); setFile(f); setHash("");
    if (!f) return;
    const ok = ["application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
      .includes(f.type);
    if (!ok) { setErr("PDF or Word only. A signed agreement is a fixed document."); return; }
    if (f.size > 25 * 1024 * 1024) { setErr("Over 25 MB."); return; }

    setBusy(true);
    const h = await hashFile(f);
    setBusy(false);
    setHash(h);

    // Same bytes under a different label is a filing mistake, not a new version.
    const dup = existing.find((v) => v.sha256 === h);
    if (dup) setErr(`This is the same file as ${dup.version_label}, uploaded ${stamp(dup.uploaded_at)}. Nothing has changed.`);
    if (!label) setLabel(new Date().toISOString().slice(0, 7) + " counsel version");
  };

  const submit = () => {
    if (!file || !hash || err) return;
    onAdd({ id: uid("av_"), version_label: label.trim() || new Date().toISOString().slice(0, 10),
      filename: file.name, mime_type: file.type, size_bytes: file.size, sha256: hash,
      effective_from: effective || null, approval_note: note.trim() || null,
      state: "uploaded", uploaded_at: nowISO(), uploaded_by: "you" });
  };

  return (
    <div className="ag-panel">
      <div className="ag-panel-h">Upload a version</div>
      <p className="ag-dim">
        The file is stored and sent exactly as you upload it. Nothing merges values
        into it or reformats it — what the tenant signs is what your lawyer approved.
      </p>

      <label className="ag-f">
        <span>File <em>PDF or Word, up to 25 MB</em></span>
        <input className="ag-in" type="file" accept=".pdf,.doc,.docx"
               onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </label>

      {file && !err && (
        <div className="ag-filecard">
          <strong>{file.name}</strong>
          <span className="ag-dim">{kb(file.size)} · {file.type.split("/").pop()}</span>
          {busy ? <span className="ag-dim">Hashing…</span>
                : hash && <span className="ag-hash">{hash}</span>}
        </div>
      )}

      <div className="ag-row">
        <label className="ag-f"><span>Version label</span>
          <input className="ag-in" value={label} placeholder="2026-08 counsel version"
                 onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="ag-f"><span>Effective from <em>optional</em></span>
          <input className="ag-in" type="date" value={effective}
                 onChange={(e) => setEffective(e.target.value)} /></label>
      </div>

      <label className="ag-f">
        <span>What changed <em>optional, but the next person will want it</em></span>
        <input className="ag-in" value={note}
               placeholder="Updated notice period clause per counsel, July review"
               onChange={(e) => setNote(e.target.value)} />
      </label>

      {err && <div className="ag-err">{err}</div>}

      <div className="ag-actions">
        <button className="ag-btn" disabled={!file || !hash || !!err || busy} onClick={submit}>
          Upload
        </button>
        <button className="ag-btn ag-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="ag-dim">It is not usable until you mark it live.</span>
      </div>
    </div>
  );
}

/* ══════════════════ Issue ══════════════════ */

/** Records that a version went to a tenant, and sends it. The figures are
 *  captured alongside rather than merged in: merging means either rewriting
 *  the approved document or filling form fields it may not have. Capturing
 *  them at the moment of issue also means a later price change cannot rewrite
 *  what this tenant was told. */
function IssueForm({ agreement, version, session, onIssue, onCancel }) {
  const [f, setF] = useState({ tenant_name: "", tenant_email: "", tenant_phone: "",
    unit_number: "", rent: "", deposit: "", start_date: "" });
  const set = (p) => setF({ ...f, ...p });
  const ok = f.tenant_name.trim() && f.unit_number.trim();

  return (
    <div className="ag-panel">
      <div className="ag-panel-h">Send {agreement.name}</div>
      <div className="ag-usingv">
        Using <strong>{version.version_label}</strong> · {version.filename}
        <span className="ag-hash">{version.sha256}</span>
      </div>

      <div className="ag-row">
        <label className="ag-f"><span>Unit</span>
          <input className="ag-in" value={f.unit_number} placeholder="378-519"
                 onChange={(e) => set({ unit_number: e.target.value })} /></label>
        <label className="ag-f"><span>Tenant</span>
          <input className="ag-in" value={f.tenant_name}
                 onChange={(e) => set({ tenant_name: e.target.value })} /></label>
      </div>
      <div className="ag-row">
        <label className="ag-f"><span>Email</span>
          <input className="ag-in" type="email" value={f.tenant_email}
                 onChange={(e) => set({ tenant_email: e.target.value })} /></label>
        <label className="ag-f"><span>Phone <em>optional</em></span>
          <input className="ag-in" value={f.tenant_phone}
                 onChange={(e) => set({ tenant_phone: e.target.value })} /></label>
      </div>

      <div className="ag-particulars">
        <div className="ag-panel-h">What you are telling them</div>
        <p className="ag-dim">
          These go in the covering message, not into the document. The agreement
          itself is untouched, and what you said here is recorded against this
          issue — a price change next month cannot rewrite it.
        </p>
        <div className="ag-row">
          <label className="ag-f"><span>Rent</span>
            <input className="ag-in" type="number" step="0.01" value={f.rent}
                   onChange={(e) => set({ rent: e.target.value })} /></label>
          <label className="ag-f"><span>Deposit</span>
            <input className="ag-in" type="number" step="0.01" value={f.deposit}
                   onChange={(e) => set({ deposit: e.target.value })} /></label>
          <label className="ag-f"><span>Start date</span>
            <input className="ag-in" type="date" value={f.start_date}
                   onChange={(e) => set({ start_date: e.target.value })} /></label>
        </div>
      </div>

      <div className="ag-actions">
        <button className="ag-btn" disabled={!ok}
                onClick={() => onIssue({ id: uid("ai_"), agreement_id: agreement.id,
                  agreement_name: agreement.name, version_id: version.id,
                  version_label: version.version_label, sha256: version.sha256,
                  filename: version.filename, ...f,
                  particulars: { rent: Number(f.rent) || null, deposit: Number(f.deposit) || null,
                                 start_date: f.start_date || null },
                  state: "prepared", issued_by: session?.name, issued_at: nowISO() })}>
          Prepare it
        </button>
        <button className="ag-btn ag-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ══════════════════ Issued ══════════════════ */

function Issued({ issues, agreements, canIssue, onSave, flash }) {
  const [filter, setFilter] = useState("all");
  const shown = issues.filter((i) => filter === "all" || i.state === filter);

  const send = (i) => {
    onSave(issues.map((x) => x.id === i.id
      ? { ...x, state: "sent", sent_at: nowISO() } : x));
    flash(`Queued to ${i.tenant_email || i.tenant_name}.`);
  };

  const markSigned = (i) => {
    onSave(issues.map((x) => x.id === i.id
      ? { ...x, state: "signed", signed_at: nowISO() } : x));
  };

  return (
    <div className="ag-body">
      <div className="ag-seg">
        {[["all", "All"], ["prepared", "Prepared"], ["sent", "Sent"], ["signed", "Signed"]]
          .map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      <p className="ag-note">
        Which version went to which tenant, and when. This is the record that
        matters in a dispute: not what the agreement said in general, but which
        file this person received.
      </p>

      {shown.length === 0 ? (
        <div className="ag-empty">Nothing here.</div>
      ) : (
        <div className="ag-issues">
          {shown.map((i) => {
            const st = ISSUE_STATE[i.state] ?? ISSUE_STATE.prepared;
            return (
              <div className="ag-issue" key={i.id}>
                <div className="ag-issue-h">
                  <span className="ag-tag" style={{ "--c": st.color }}>{st.label}</span>
                  <strong>{i.tenant_name}</strong>
                  <span className="ag-mono">{i.unit_number}</span>
                  <span className="ag-dim">{i.agreement_name}</span>
                </div>
                <div className="ag-dim">
                  {i.version_label} · issued {stamp(i.issued_at)} by {i.issued_by ?? "—"}
                  {i.sent_at && <> · sent {stamp(i.sent_at)}</>}
                  {i.signed_at && <> · signed {stamp(i.signed_at)}</>}
                </div>
                {(i.particulars?.rent || i.particulars?.start_date) && (
                  <div className="ag-particulars-shown">
                    {i.particulars.rent && <span>Rent {money(i.particulars.rent)}</span>}
                    {i.particulars.deposit && <span>Deposit {money(i.particulars.deposit)}</span>}
                    {i.particulars.start_date && <span>From {i.particulars.start_date}</span>}
                  </div>
                )}
                <div className="ag-hash">{i.sha256}</div>
                {canIssue && (
                  <div className="ag-actions">
                    {i.state === "prepared" && (
                      <button className="ag-btn ag-btn--xs" disabled={!i.tenant_email}
                              onClick={() => send(i)}>
                        Send to tenant
                      </button>
                    )}
                    {i.state === "sent" && (
                      <button className="ag-btn ag-btn--xs ag-btn--ghost"
                              onClick={() => markSigned(i)}>Mark signed by hand</button>
                    )}
                    {i.state === "prepared" && !i.tenant_email && (
                      <span className="ag-dim">No email on file</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════ Signing ══════════════════ */

/** Requests out for signature and where each has got to.
 *
 *  The one worth acting on is "opened and not signed". Somebody who read it
 *  three days ago and stopped usually has a question, and asking beats
 *  reminding. */
function Signing({ signatures, agreements, canIssue, session, onSave, flash }) {
  const [filter, setFilter] = useState("open");
  const [preparing, setPreparing] = useState(false);
  const [detail, setDetail] = useState(null);

  const shown = signatures.filter((s) => {
    if (filter === "open") return !["completed", "voided", "declined"].includes(s.state);
    if (filter === "all") return true;
    return s.state === filter;
  });

  const stalled = signatures.filter((s) => s.state === "viewed"
    && s.viewed_at && Date.now() - new Date(s.viewed_at).getTime() > 2 * 864e5);

  const remind = (rq) => {
    onSave(signatures.map((x) => x.id === rq.id
      ? { ...x, reminded_at: nowISO(), reminder_count: (x.reminder_count ?? 0) + 1 } : x));
    flash(`Reminder queued to ${rq.parties?.[0]?.email ?? "the signer"}.`);
  };

  const voidIt = (rq, reason) => {
    onSave(signatures.map((x) => x.id === rq.id
      ? { ...x, state: "voided", voided_reason: reason } : x));
    flash("Voided. Anything already signed under it stays retrievable.");
  };

  return (
    <div className="ag-body">
      <div className="ag-cardh">
        <div className="ag-seg">
          {[["open", "In progress"], ["completed", "Complete"],
            ["declined", "Declined"], ["all", "All"]].map(([k, l]) => (
            <button key={k} className={filter === k ? "on" : ""}
                    onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {canIssue && (
          <button className="ag-btn ag-btn--sm" onClick={() => setPreparing(!preparing)}>
            Send for signature
          </button>
        )}
      </div>

      <p className="ag-note">
        The document is signed as it was sent — signatures are drawn on top and
        nothing in the text moves. Every request carries a certificate recording
        who signed, when, from where, and the hash of the file before and after.
        That trail is what answers a challenge; the drawn mark on its own does not.
      </p>

      {stalled.length > 0 && (
        <div className="ag-stalled">
          <strong>{stalled.length} opened and not signed.</strong>
          <span>
            {" "}Somebody who read it days ago and stopped usually has a question.
            A call gets further than another reminder.
          </span>
        </div>
      )}

      {preparing && canIssue && (
        <PrepareSignature agreements={agreements} session={session}
          onCancel={() => setPreparing(false)}
          onCreate={(rq) => { onSave([rq, ...signatures]); setPreparing(false);
                              flash(`Prepared. Send it when you are ready.`); }} />
      )}

      {shown.length === 0 ? (
        <div className="ag-empty">Nothing here.</div>
      ) : (
        <div className="ag-issues">
          {shown.map((rq) => {
            const st = SIG_STATE[rq.state] ?? SIG_STATE.draft;
            const signed = (rq.parties ?? []).filter((p) => p.signed_at).length;
            return (
              <div className="ag-issue" key={rq.id}>
                <div className="ag-issue-h">
                  <span className="ag-tag" style={{ "--c": st.color }}>{st.label}</span>
                  <strong className="ag-mono">{rq.reference}</strong>
                  <span className="ag-mono">{rq.unit_number}</span>
                  <span className="ag-dim">{rq.agreement_name}</span>
                </div>

                <div className="ag-sigparties">
                  {(rq.parties ?? []).map((p, i) => (
                    <div className={`ag-sigparty ${p.signed_at ? "done" : ""}`} key={i}>
                      <span className="ag-sigorder">{p.sign_order ?? i + 1}</span>
                      <div>
                        <strong>{p.full_name}</strong>
                        <span className="ag-dim"> {p.role}</span>
                        <div className="ag-dim">
                          {p.signed_at ? `Signed ${stamp(p.signed_at)}`
                            : p.viewed_at ? `Opened ${stamp(p.viewed_at)}, not signed`
                            : "Not opened"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="ag-dim">
                  {rq.version_label} · sent {stamp(rq.created_at)} by {rq.created_name}
                  {rq.expires_at && ` · expires ${String(rq.expires_at).slice(0, 10)}`}
                </div>

                {rq.declined_reason && (
                  <div className="ag-vnote ag-vnote--bad">
                    Declined: {rq.declined_reason}
                  </div>
                )}

                {rq.signed_sha256 && <div className="ag-hash">{rq.signed_sha256}</div>}

                <div className="ag-actions">
                  {canIssue && rq.state === "draft" && (
                    <button className="ag-btn ag-btn--xs"
                            onClick={() => { onSave(signatures.map((x) => x.id === rq.id
                              ? { ...x, state: "sent", sent_at: nowISO() } : x));
                              flash("Sent."); }}>
                      Send it
                    </button>
                  )}
                  {canIssue && ["sent", "viewed", "signed"].includes(rq.state) && (
                    <button className="ag-btn ag-btn--xs ag-btn--ghost"
                            onClick={() => remind(rq)}>Remind</button>
                  )}
                  {rq.state === "completed" && (
                    <>
                      <button className="ag-btn ag-btn--xs ag-btn--ghost">
                        Signed copy
                      </button>
                      <button className="ag-btn ag-btn--xs ag-btn--ghost">
                        Certificate
                      </button>
                    </>
                  )}
                  {canIssue && !["completed", "voided"].includes(rq.state) && (
                    <button className="ag-btn ag-btn--xs ag-btn--ghost"
                            onClick={() => { const why = prompt("Why void it?");
                              if (why?.trim()) voidIt(rq, why.trim()); }}>
                      Void
                    </button>
                  )}
                  {rq.state === "completed" && (
                    <span className="ag-dim">
                      Copy sent to everyone who signed
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Preparing a request. Fields are placed by page and position, which is the
 *  part that needs care: a signature box over a clause hides the clause. */
function PrepareSignature({ agreements, session, onCancel, onCreate }) {
  const withVersion = agreements.filter((a) => a.versions?.some((v) => v.state === "approved"));
  const [agreementId, setAgreementId] = useState(withVersion[0]?.id ?? "");
  const [f, setF] = useState({ unit_number: "", tenant_name: "", tenant_email: "",
    landlord_name: session?.name ?? "", landlord_email: "", message: "",
    rent: "", deposit: "", start_date: "", locale: "en", countersign: true });
  const [fields, setFields] = useState([
    { party_index: 0, kind: "signature", label: "Tenant signature", page: 1, x: 72, y: 120,
      width: 200, height: 48 },
    { party_index: 0, kind: "date", label: "Date", page: 1, x: 320, y: 120,
      width: 120, height: 24 },
  ]);
  const set = (p) => setF({ ...f, ...p });

  const agreement = agreements.find((a) => a.id === agreementId);
  const version = agreement?.versions?.find((v) => v.state === "approved");
  const ok = agreementId && f.unit_number.trim() && f.tenant_name.trim()
    && f.tenant_email.trim();

  return (
    <section className="ag-card">
      <div className="ag-panel-h">Send for signature</div>

      {withVersion.length === 0 ? (
        <div className="ag-empty">
          No approved agreement to send. Admin has to upload and approve one first.
        </div>
      ) : (
        <>
          <div className="ag-row">
            <label className="ag-f"><span>Agreement</span>
              <select className="ag-in" value={agreementId}
                      onChange={(e) => setAgreementId(e.target.value)}>
                {withVersion.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select></label>
            <label className="ag-f"><span>Unit</span>
              <input className="ag-in" value={f.unit_number} placeholder="378-519"
                     onChange={(e) => set({ unit_number: e.target.value })} /></label>
          </div>

          {version && (
            <div className="ag-usingv">
              Using <strong>{version.version_label}</strong> · {version.filename}
              <span className="ag-hash">{version.sha256}</span>
            </div>
          )}

          <div className="ag-row">
            <label className="ag-f"><span>Tenant</span>
              <input className="ag-in" value={f.tenant_name}
                     onChange={(e) => set({ tenant_name: e.target.value })} /></label>
            <label className="ag-f"><span>Their email</span>
              <input className="ag-in" type="email" value={f.tenant_email}
                     onChange={(e) => set({ tenant_email: e.target.value })} /></label>
            <label className="ag-f"><span>Language</span>
              <select className="ag-in" value={f.locale}
                      onChange={(e) => set({ locale: e.target.value })}>
                <option value="en">English</option>
                <option value="zh">繁體中文</option>
              </select></label>
          </div>

          <label className="ag-check">
            <input type="checkbox" checked={f.countersign}
                   onChange={(e) => set({ countersign: e.target.checked })} />
            <span>
              I countersign after the tenant
              <em> — the usual order. A countersignature on a document the tenant
              has not signed means nothing.</em>
            </span>
          </label>

          <div className="ag-particulars">
            <div className="ag-panel-h">What you are telling them</div>
            <p className="ag-dim">
              These go in the covering message and on the signing page, not into
              the document. Captured now, so a price change next month cannot
              rewrite what this tenant was told.
            </p>
            <div className="ag-row">
              <label className="ag-f"><span>Rent</span>
                <input className="ag-in" type="number" step="0.01" value={f.rent}
                       onChange={(e) => set({ rent: e.target.value })} /></label>
              <label className="ag-f"><span>Deposit</span>
                <input className="ag-in" type="number" step="0.01" value={f.deposit}
                       onChange={(e) => set({ deposit: e.target.value })} /></label>
              <label className="ag-f"><span>Start date</span>
                <input className="ag-in" type="date" value={f.start_date}
                       onChange={(e) => set({ start_date: e.target.value })} /></label>
            </div>
          </div>

          <label className="ag-f"><span>Note to the tenant <em>optional</em></span>
            <input className="ag-in" value={f.message}
                   placeholder="Anything they should know before signing"
                   onChange={(e) => set({ message: e.target.value })} /></label>

          <div className="ag-fieldbox">
            <div className="ag-panel-h">Where the signatures go</div>
            <p className="ag-dim">
              Page and position, in points from the bottom-left of the page.
              Check the placement against the document — a signature box over a
              clause hides the clause.
            </p>
            {fields.map((fl, i) => (
              <div className="ag-fieldrow" key={i}>
                <select className="ag-in" value={fl.kind}
                        onChange={(e) => setFields(fields.map((x, j) =>
                          j === i ? { ...x, kind: e.target.value } : x))}>
                  {["signature", "initials", "date", "text", "checkbox"].map((k) =>
                    <option key={k} value={k}>{k}</option>)}
                </select>
                <input className="ag-in" placeholder="Label" value={fl.label ?? ""}
                       onChange={(e) => setFields(fields.map((x, j) =>
                         j === i ? { ...x, label: e.target.value } : x))} />
                <input className="ag-in" type="number" placeholder="Page" value={fl.page}
                       onChange={(e) => setFields(fields.map((x, j) =>
                         j === i ? { ...x, page: Number(e.target.value) } : x))} />
                <input className="ag-in" type="number" placeholder="x" value={fl.x}
                       onChange={(e) => setFields(fields.map((x, j) =>
                         j === i ? { ...x, x: Number(e.target.value) } : x))} />
                <input className="ag-in" type="number" placeholder="y" value={fl.y}
                       onChange={(e) => setFields(fields.map((x, j) =>
                         j === i ? { ...x, y: Number(e.target.value) } : x))} />
                {fields.length > 1 && (
                  <button className="ag-x"
                          onClick={() => setFields(fields.filter((_, j) => j !== i))}>×</button>
                )}
              </div>
            ))}
            <button className="ag-btn ag-btn--xs ag-btn--ghost"
                    onClick={() => setFields([...fields, { party_index: 0, kind: "signature",
                      label: "", page: 1, x: 72, y: 200, width: 200, height: 48 }])}>
              + Another field
            </button>
          </div>

          <div className="ag-actions">
            <button className="ag-btn" disabled={!ok}
                    onClick={() => onCreate({
                      id: uid("sr_"),
                      reference: "SIG-" + Math.random().toString(16).slice(2, 10).toUpperCase(),
                      agreement_id: agreementId, agreement_name: agreement?.name,
                      version_id: version?.id, version_label: version?.version_label,
                      source_sha256: version?.sha256, unit_number: f.unit_number,
                      locale: f.locale, message: f.message,
                      particulars: { rent: Number(f.rent) || null,
                        deposit: Number(f.deposit) || null, start_date: f.start_date || null },
                      parties: [
                        { role: "tenant", full_name: f.tenant_name, email: f.tenant_email,
                          sign_order: 1 },
                        ...(f.countersign ? [{ role: "landlord", full_name: f.landlord_name,
                          email: f.landlord_email, sign_order: 2 }] : []),
                      ],
                      fields, state: "draft", created_name: session?.name,
                      created_at: nowISO(),
                      expires_at: new Date(Date.now() + 14 * 864e5).toISOString(),
                    })}>
              Prepare it
            </button>
            <button className="ag-btn ag-btn--ghost" onClick={onCancel}>Cancel</button>
            <span className="ag-dim">Nothing goes out until you send it.</span>
          </div>
        </>
      )}
    </section>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.ag{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:#1C6FA6;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:40px}
.ag *{box-sizing:border-box}
.ag-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.ag-dim{color:var(--dim);font-size:12.5px}
.ag-cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ag-load{padding:80px 20px;text-align:center;color:var(--dim)}

.ag-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ag-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ag-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0}
.ag-headr{display:flex;gap:10px;align-items:center}
.ag-ready{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--dim);
  border:1px solid var(--rule);border-radius:3px;padding:4px 9px}
.ag-chip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px}

.ag-tabs{display:flex;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ag-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;
  border:0;padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;
  margin-bottom:-1px;display:flex;align-items:center;gap:6px}
.ag-tabs button.on{color:var(--ink);border-bottom-color:var(--ink)}
.ag-tabs i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;
  background:var(--dim);color:#fff;border-radius:8px;padding:1px 6px}

.ag-block{background:#FDF6F7;border-bottom:1px solid var(--red);padding:12px 26px;
  font-size:13px;color:var(--red);line-height:1.7}
.ag-block strong{display:inline}
.ag-block span{color:var(--ink2)}
.ag-flash{background:#F5FAF8;border-bottom:1px solid var(--green);padding:9px 26px;
  font-size:12.5px;color:var(--green)}

.ag-body{padding:18px 26px;max-width:1240px}
.ag-split{display:grid;grid-template-columns:minmax(230px,300px) 1fr;gap:16px;align-items:start}
.ag-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ag-note{background:var(--paper);padding:12px 14px;font-size:12px;color:var(--dim);
  line-height:1.7}
.ag-item{font:inherit;text-align:left;cursor:pointer;background:var(--paper);border:0;
  padding:10px 14px;display:flex;flex-direction:column;gap:3px}
.ag-item:hover{background:#FAFBFC}
.ag-item.on{background:var(--ink)}
.ag-item.on .ag-item-n{color:#fff}
.ag-item.on .ag-item-m{color:rgba(255,255,255,.7)}
.ag-item-n{font-size:13px;font-weight:600}
.ag-item-m{font-size:11.5px;color:var(--dim);display:flex;align-items:center;gap:6px}
.ag-dot{width:6px;height:6px;border-radius:50%;background:var(--rule);display:inline-block}
.ag-dot--ok{background:var(--green)}

.ag-detail{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:18px 20px;display:flex;flex-direction:column;gap:12px;min-height:280px}
.ag-dh{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.ag-dh h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:17px;margin:0}
.ag-dh-r{display:flex;gap:8px;flex-wrap:wrap}
.ag-caution{background:var(--amber);border:1px solid var(--amberline);border-radius:3px;
  padding:9px 12px;font-size:12.5px;color:#6B5410;line-height:1.7;margin:0}
.ag-empty{color:var(--dim);font-size:12.5px;padding:26px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

.ag-versions{display:flex;flex-direction:column;gap:10px}
.ag-version{border:1px solid var(--rule);border-radius:4px;padding:12px 14px;
  display:flex;flex-direction:column;gap:5px}
.ag-version.live{border-color:var(--green);border-left:3px solid var(--green);background:#FCFEFD}
.ag-version-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ag-version-h strong{font-size:13.5px}
.ag-tag{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;
  padding:1px 8px;white-space:nowrap}
.ag-vnote{font-size:12.5px;color:var(--ink2);border-left:2px solid var(--rule);
  padding-left:9px;line-height:1.65}
.ag-vnote--bad{border-left-color:var(--red);color:var(--red)}
.ag-hash{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--dim);
  word-break:break-all;background:#F7F9FB;border-radius:2px;padding:4px 7px}
.ag-live-note{font-size:12px;color:var(--green);margin:2px 0 0;line-height:1.7}

.ag-panel{border:1px solid var(--accent);border-radius:4px;padding:14px 16px;background:#FAFCFE;
  display:flex;flex-direction:column;gap:10px}
.ag-panel-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim)}
.ag-filecard{border:1px solid var(--rule);border-radius:3px;padding:9px 12px;background:var(--paper);
  display:flex;flex-direction:column;gap:3px}
.ag-usingv{border:1px solid var(--rule);border-radius:3px;padding:9px 12px;background:var(--paper);
  font-size:12.5px;display:flex;flex-direction:column;gap:4px}
.ag-particulars{border-top:1px solid var(--rule);padding-top:10px;display:flex;
  flex-direction:column;gap:8px}
.ag-particulars-shown{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--ink2)}

.ag-row{display:flex;gap:10px;flex-wrap:wrap}
.ag-row>*{flex:1 1 140px}
.ag-f{display:flex;flex-direction:column;gap:4px}
.ag-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.ag-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.ag-in{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--rule);
  border-radius:3px;background:var(--paper);color:var(--ink);width:100%;min-width:0}
.ag-in--sm{padding:5px 8px;font-size:12px;width:auto}
.ag-in:focus{outline:2px solid var(--accent);outline-offset:1px}

.ag-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--ink);
  color:#fff;border:1px solid var(--ink);padding:8px 15px;border-radius:3px}
.ag-btn:hover:not(:disabled){background:#000}
.ag-btn:disabled{opacity:.4;cursor:not-allowed}
.ag-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ag-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.ag-btn--sm{padding:6px 12px;font-size:12px}
.ag-btn--xs{padding:4px 9px;font-size:11.5px}
.ag-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.ag-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ag-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:9px 12px;line-height:1.6}

.ag-seg{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden;
  background:var(--paper);margin-bottom:12px}
.ag-seg button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:0;border-right:1px solid var(--rule);padding:8px 16px;color:var(--dim)}
.ag-seg button:last-child{border-right:0}
.ag-seg button.on{background:var(--ink);color:#fff}

.ag-issues{display:flex;flex-direction:column;gap:10px}
.ag-issue{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:12px 14px;display:flex;flex-direction:column;gap:5px}
.ag-issue-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13.5px}

.ag-foot{padding:6px 26px 0;color:var(--dim);font-size:11.5px;max-width:92ch;line-height:1.75}

.ag-sigparties{display:flex;flex-direction:column;gap:6px;border-left:2px solid var(--rule);
  padding-left:11px;margin:4px 0}
.ag-sigparty{display:flex;gap:9px;align-items:flex-start;font-size:12.5px}
.ag-sigparty.done .ag-sigorder{background:var(--green);color:#fff}
.ag-sigorder{flex:0 0 18px;height:18px;border-radius:50%;background:var(--ground);
  display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;
  color:var(--dim);margin-top:1px}
.ag-stalled{background:var(--amber);border:1px solid var(--amberline);border-radius:4px;
  padding:11px 14px;font-size:12.5px;color:#6B5410;line-height:1.7}
.ag-check{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;color:var(--ink2);
  line-height:1.6;cursor:pointer}
.ag-check input{margin-top:3px}
.ag-check em{font-style:normal;color:var(--dim)}
.ag-fieldbox{border:1px solid var(--rule);border-radius:4px;padding:12px 14px;
  display:flex;flex-direction:column;gap:7px;background:#FCFDFE}
.ag-fieldrow{display:grid;grid-template-columns:110px minmax(90px,1fr) 64px 64px 64px 24px;
  gap:6px;align-items:center}

@media (max-width:860px){
  .ag-fieldrow{grid-template-columns:1fr}
  .ag-split{grid-template-columns:1fr}
  .ag-head,.ag-tabs,.ag-body,.ag-block,.ag-foot{padding-left:16px;padding-right:16px}
}
`;
