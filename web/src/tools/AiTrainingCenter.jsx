import React, { useCallback, useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const STATUS = { pending: "Pending review", approved: "Good example", excluded: "Do not learn" };
const stamp = (s) => s ? new Date(s).toLocaleString() : "—";

export default function AiTrainingCenter({ session }) {
  const [data, setData] = useState({ examples: [], stats: [], rules: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");
  const [task, setTask] = useState("all");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("examples");
  const [busy, setBusy] = useState("");
  const [rule, setRule] = useState({ title: "", instruction: "", task: "" });

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (task !== "all") p.set("task", task);
      if (q.trim()) p.set("q", q.trim());
      setData(await api.aiTraining(`?${p}`));
    } catch (e) { setError(e.code === "HTTP_500" ? "Run migration 018 in Supabase first." : e.code); }
    finally { setLoading(false); }
  }, [status, task, q]);
  useEffect(() => { load(); }, [load]);

  const tasks = useMemo(() => [...new Set(data.examples.map((x) => x.task))].sort(), [data.examples]);
  const counts = Object.fromEntries(data.stats.map((x) => [x.review_status, x.count]));

  const review = async (id, next) => {
    let reason = "";
    if (next === "excluded") reason = window.prompt("Optional reason this should not be learned:") ?? "";
    setBusy(id);
    try { await api.reviewAiExample(id, next, reason); await load(); }
    catch (e) { setError(e.code); } finally { setBusy(""); }
  };

  const addRule = async (e) => {
    e.preventDefault(); setBusy("rule");
    try {
      await api.createAiRule({ ...rule, task: rule.task || null });
      setRule({ title: "", instruction: "", task: "" }); await load();
    } catch (e) { setError(e.code); } finally { setBusy(""); }
  };

  if (session?.role !== "admin") return <div className="at"><style>{CSS}</style><div className="at-card">Admin only.</div></div>;
  return <div className="at"><style>{CSS}</style>
    <header><div><small>Baydo Pointe · Admin</small><h1>AI Training Center</h1>
      <p>Only approved examples and active company rules are shown to the AI.</p></div>
      <div className="at-stats"><b>{counts.pending || 0}<span>Pending</span></b><b>{counts.approved || 0}<span>Good</span></b><b>{counts.excluded || 0}<span>Excluded</span></b></div>
    </header>
    <nav><button className={tab === "examples" ? "on" : ""} onClick={() => setTab("examples")}>Training examples</button><button className={tab === "rules" ? "on" : ""} onClick={() => setTab("rules")}>Company AI rules</button></nav>
    {error && <div className="at-error">{error}</div>}
    {tab === "examples" ? <main>
      <div className="at-filters">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search input or approved answer" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option>{Object.entries(STATUS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={task} onChange={(e) => setTask(e.target.value)}><option value="all">All tasks</option>{tasks.map((x) => <option key={x}>{x}</option>)}</select>
      </div>
      {loading ? <div className="at-empty">Loading…</div> : data.examples.length === 0 ? <div className="at-empty">No examples found.</div> : data.examples.map((x) => <article key={x.id}>
        <div className="at-meta"><span className={`s ${x.review_status}`}>{STATUS[x.review_status]}</span><strong>{x.task}</strong><span>{x.model}</span><span>{stamp(x.created_at)}</span>{x.was_edited && <span>Staff edited</span>}</div>
        <div className="at-cols"><section><label>Original input</label><pre>{x.original_input}</pre></section><section><label>AI draft</label><pre>{x.ai_draft}</pre></section><section><label>Approved final</label><pre>{x.approved_output}</pre></section></div>
        {x.exclusion_reason && <p className="reason">Reason: {x.exclusion_reason}</p>}
        <div className="at-actions"><button disabled={busy === x.id} onClick={() => review(x.id, "approved")}>Good example</button><button className="bad" disabled={busy === x.id} onClick={() => review(x.id, "excluded")}>Do not learn</button><button className="ghost" disabled={busy === x.id} onClick={() => review(x.id, "pending")}>Return to pending</button></div>
      </article>)}
    </main> : <main>
      <form className="at-card" onSubmit={addRule}><h2>Add company rule</h2><div className="at-ruleform"><input required maxLength="120" placeholder="Rule title" value={rule.title} onChange={(e) => setRule({...rule,title:e.target.value})}/><input placeholder="Task (blank = all AI tasks)" value={rule.task} onChange={(e) => setRule({...rule,task:e.target.value})}/><textarea required maxLength="4000" placeholder="Exact instruction the AI must follow" value={rule.instruction} onChange={(e) => setRule({...rule,instruction:e.target.value})}/><button disabled={busy === "rule"}>Add rule</button></div></form>
      <div className="at-rules">{data.rules.map((x) => <article key={x.id} className={!x.is_active ? "off" : ""}><div><strong>{x.title}</strong><span>{x.task || "All tasks"}</span></div><p>{x.instruction}</p><footer><span>Updated {stamp(x.updated_at)} by {x.updated_by_name || "Admin"}</span><button className="ghost" onClick={async()=>{setBusy(x.id);await api.updateAiRule(x.id,{is_active:!x.is_active});await load();setBusy("");}}>{x.is_active ? "Disable" : "Enable"}</button></footer></article>)}</div>
    </main>}
  </div>;
}

const CSS = `
.at{min-height:100vh;background:#edf0f3;color:#17212b;font:14px/1.5 system-ui,sans-serif;padding-bottom:40px}.at *{box-sizing:border-box}.at header{background:#fff;border-bottom:1px solid #d5dde3;padding:24px 28px;display:flex;justify-content:space-between;gap:20px;align-items:end}.at small{color:#758595;text-transform:uppercase;letter-spacing:.12em}.at h1{margin:3px 0;font-size:26px;color:var(--brand)}.at header p{margin:0;color:#657585}.at-stats{display:flex;gap:10px}.at-stats b{background:#f4f6f8;border:1px solid #d5dde3;border-radius:5px;min-width:78px;padding:8px 12px;text-align:center;font-size:20px}.at-stats span{display:block;font-size:10px;color:#758595;text-transform:uppercase}.at nav{background:#fff;padding:0 28px;border-bottom:1px solid #d5dde3}.at nav button{border:0;background:none;padding:13px 16px;font-weight:650;color:#758595;border-bottom:2px solid transparent}.at nav button.on{color:var(--brand);border-color:var(--brand)}.at main{padding:18px 28px;max-width:1400px}.at-filters{display:grid;grid-template-columns:1fr 180px 180px;gap:10px;margin-bottom:14px}.at input,.at select,.at textarea{font:inherit;border:1px solid #cad4dc;border-radius:4px;background:#fff;padding:9px 11px}.at textarea{min-height:110px;resize:vertical}.at article,.at-card{background:#fff;border:1px solid #d5dde3;border-radius:5px;margin-bottom:12px;padding:15px}.at-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#758595;font-size:12px}.at-meta strong{color:#17212b}.s{font-weight:700;border-radius:12px;padding:2px 9px}.s.pending{background:#fff4d6;color:#785c10}.s.approved{background:#e3f5ef;color:#087566}.s.excluded{background:#f9e8ec;color:#aa3550}.at-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}.at-cols section{min-width:0}.at label{font-size:11px;font-weight:700;text-transform:uppercase;color:#758595}.at pre{white-space:pre-wrap;word-break:break-word;background:#f6f8f9;border:1px solid #e0e6ea;border-radius:4px;padding:10px;max-height:240px;overflow:auto;font:12.5px/1.55 ui-monospace,monospace}.at-actions{display:flex;gap:8px}.at button{font:inherit;cursor:pointer;border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:4px;padding:7px 12px;font-weight:650}.at button.bad{background:#aa3550;border-color:#aa3550}.at button.ghost{background:#fff;color:#526272;border-color:#cad4dc}.at button:disabled{opacity:.45}.at-error{margin:14px 28px 0;background:#f9e8ec;color:#aa3550;padding:10px 13px;border:1px solid #e6b6c1;border-radius:4px}.at-empty{padding:50px;text-align:center;color:#758595}.reason{color:#aa3550;font-size:12px}.at-ruleform{display:grid;grid-template-columns:1fr 1fr;gap:10px}.at-ruleform textarea{grid-column:1/-1}.at-ruleform button{justify-self:start}.at-card h2{margin-top:0}.at-rules article.off{opacity:.58}.at-rules article>div,.at-rules footer{display:flex;justify-content:space-between;gap:12px;align-items:center}.at-rules article>div span,.at-rules footer span{font-size:12px;color:#758595}.at-rules footer{border-top:1px solid #e5eaee;padding-top:10px}.at-rules p{white-space:pre-wrap}.at-card{max-width:900px}@media(max-width:900px){.at-cols{grid-template-columns:1fr}.at-filters{grid-template-columns:1fr}.at header{align-items:start;flex-direction:column}.at-ruleform{grid-template-columns:1fr}.at main,.at header,.at nav{padding-left:16px;padding-right:16px}}
`;
