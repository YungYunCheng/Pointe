import React from "react";
import { useSearchParams } from "react-router-dom";
import Confirmations from "./Confirmations.jsx";
import AiInbox from "./AiInbox.jsx";

/* One place for customer messages and the work they create. Chat escalations
 * are live operational messages; other confirmations may move money or change
 * a lease; AI testing is deliberately kept separate from both. */
export default function Messages({ session }) {
  const [search, setSearch] = useSearchParams();
  const canTest = ["admin", "property_manager"].includes(session?.role);
  const tabs = [
    ["chat", "Chat messages"],
    ["confirmations", "Other confirmations"],
    ...(canTest ? [["testing", "AI testing"]] : []),
  ];
  const requested = search.get("tab") || "chat";
  const tab = tabs.some(([key]) => key === requested) ? requested : "chat";

  const select = (next) => {
    const value = new URLSearchParams(search);
    if (next === "chat") value.delete("tab");
    else value.set("tab", next);
    setSearch(value, { replace: true });
  };

  return (
    <section className="msg-center">
      <style>{CSS}</style>
      <header className="msg-head">
        <div className="msg-eyebrow">Baydo Pointe · Messages</div>
        <h1>Messages</h1>
        <p>Customer conversations, staff confirmations and AI testing are together without mixing their records.</p>
      </header>

      <nav className="msg-tabs" aria-label="Message sections">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "on" : ""}
                  onClick={() => select(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "chat" && <Confirmations session={session} section="chat" embedded />}
      {tab === "confirmations" && <Confirmations session={session} section="proposals" embedded />}
      {tab === "testing" && canTest && <AiInbox session={session} embedded />}
    </section>
  );
}

const CSS = `
.msg-center{min-height:100vh;background:#E9EDF0;color:#131C25}
.msg-head{background:#fff;border-bottom:1px solid #D3DBE1;padding:24px 28px 18px}
.msg-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:#78899A}
.msg-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-size:26px;line-height:1.2;
  letter-spacing:-.02em;margin:4px 0 5px}
.msg-head p{margin:0;color:#647586;font-size:13px;line-height:1.55}
.msg-tabs{display:flex;gap:2px;overflow-x:auto;padding:0 26px;background:#fff;border-bottom:1px solid #D3DBE1}
.msg-tabs button{font:inherit;font-size:13.5px;font-weight:600;white-space:nowrap;cursor:pointer;
  color:#78899A;background:transparent;border:0;border-bottom:2px solid transparent;
  margin-bottom:-1px;padding:13px 16px}
.msg-tabs button.on{color:var(--brand,#173B5F);border-bottom-color:var(--brand,#173B5F)}
.msg-tabs button:focus-visible{outline:2px solid var(--brand,#173B5F);outline-offset:-3px}
@media(max-width:720px){.msg-head{padding:20px 18px 15px}.msg-tabs{padding:0 8px}}
`;
