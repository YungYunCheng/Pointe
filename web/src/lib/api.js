/* ============================================================
   API client
   ------------------------------------------------------------
   The tools currently read and write browser storage directly.
   Swap those calls for these as each tool is wired up: the
   storage keys and the endpoints line up one to one, listed in
   web/README.md.

   In dev, Vite proxies /api to the server, so the browser only
   ever talks to one origin and there is no CORS to configure.
   In the container, nginx does the same thing.
   ============================================================ */

const BASE = import.meta.env.VITE_API_URL || "";
const TOKEN_KEY = "baydo:token";

/* Browser sessions live only in an HttpOnly cookie. Remove any token left by
   the prototype so script injection cannot copy a reusable credential. */
export const getToken = () => null;
export const setToken = () => localStorage.removeItem(TOKEN_KEY);

/** Thrown for any non-2xx. Carries the server's message code so the
 *  caller can translate it rather than showing raw English. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.code || `HTTP_${status}`);
    this.status = status;
    this.code = payload?.code || `HTTP_${status}`;
    this.payload = payload || {};
  }
}

async function request(method, path, body, opts = {}) {
  const headers = {};

  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: payload, credentials: "include", ...opts,
  });

  // A 401 anywhere means the session is gone. Clear it so the next render
  // sends the user back to sign-in instead of looping on failed calls.
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent("baydo:signed-out"));
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get:   (p)      => request("GET", p),
  post:  (p, b)   => request("POST", p, b),
  patch: (p, b)   => request("PATCH", p, b),
  del:   (p)      => request("DELETE", p),

  /* ---- auth ---- */
  async login(email, password) {
    const out = await request("POST", "/public/auth/login", { email, password });
    return out.user;
  },
  async logout() {
    try { await request("POST", "/auth/logout"); } finally { setToken(null); }
  },
  me:             ()            => request("GET", "/auth/me"),
  forgot:         (email)       => request("POST", "/public/auth/forgot", { email }),
  reset:          (token, pw)   => request("POST", "/public/auth/reset", { token, password: pw }),
  changePassword: (cur, pw)     => request("POST", "/auth/change-password", { current: cur, password: pw }),

  /* ---- property ---- */
  units:      ()                => request("GET", "/units"),
  setStatus:  (unit, patch)     => request("PATCH", `/units/${unit}`, patch),
  unitLedger: (unit)            => request("GET", `/units/${unit}/ledger`),
  addLedgerCharge: (unit, body) => request("POST", `/units/${unit}/ledger/charges`, body),
  voidLedgerCharge: (unit, id, reason) =>
    request("POST", `/units/${unit}/ledger/charges/${id}/void`, { reason }),
  manualPayment: (body)         => request("POST", "/payments/manual", body),
  reversePayment: (id, reason)  => request("POST", `/payments/${id}/reverse`, { reason }),
  manualPaymentMethods: ()      => request("GET", "/payment-methods/manual"),
  createLease:(payload)         => request("POST", "/leases", payload),
  updateResident: (lease, patch)=> request("PATCH", `/leases/${lease}/resident`, patch),
  pricing:    ()                => request("GET", "/pricing"),
  publishPricing: (payload)     => request("POST", "/pricing", payload),

  /* ---- parking: the server settles who gets the last stall ---- */
  parking:      ()              => request("GET", "/parking"),
  setQuota:     (code, total)   => request("PATCH", `/parking/pools/${code}`, { total_stalls: total }),
  requestStall: (payload)       => request("POST", "/parking/request", payload),
  releaseStall: (id)            => request("POST", `/parking/${id}/release`),

  /* ---- signing lock: first to sign wins ---- */
  getLock:     (unit)           => request("GET", `/locks/${unit}`),
  acquireLock: (unit)           => request("POST", `/locks/${unit}`),
  releaseLock: (unit)           => request("DELETE", `/locks/${unit}`),

  /* ---- move-out ---- */
  moveouts:      ()                   => request("GET", "/moveouts"),
  createMoveout: (payload)            => request("POST", "/moveouts", payload),
  moveoutStep:   (id, step, payload)  => request("POST", `/moveouts/${id}/steps/${step}`, payload),
  vacate:        (id)                 => request("POST", `/moveouts/${id}/vacate`),
  addDeduction:  (id, payload)        => request("POST", `/moveouts/${id}/deductions`, payload),
  notifyDeductions: (id)              => request("POST", `/moveouts/${id}/deductions/notify`),
  updateDeduction:  (id, patch)       => request("PATCH", `/deductions/${id}`, patch),

  /* ---- evidence: multipart, so no JSON content type ---- */
  uploadEvidence(entityType, entityId, files, meta = {}) {
    const fd = new FormData();
    fd.append("entity_type", entityType);
    fd.append("entity_id", entityId);
    for (const [k, v] of Object.entries(meta)) fd.append(k, v);
    for (const f of files) fd.append("files", f);
    return request("POST", "/evidence", fd);
  },
  evidence: (type, id) => request("GET", `/evidence/${type}/${id}`),
  evidenceUrl: (id)    => `${BASE}/api/evidence/file/${id}`,

  /* ---- maintenance and entry notices ---- */
  maintenance:        ()            => request("GET", "/maintenance"),
  createTicket:       (payload)     => request("POST", "/maintenance", payload),
  updateTicket:       (id, patch)   => request("PATCH", `/maintenance/${id}`, patch),
  addTicketNote:      (id, body)    => request("POST", `/maintenance/${id}/notes`, { body }),
  pendingNotices:     ()            => request("GET", "/entry-notices/pending"),
  createNotice:       (payload)     => request("POST", "/entry-notices", payload),
  sendNotice:         (id)          => request("POST", `/entry-notices/${id}/send`),

  /* ---- renewals ---- */
  renewals:       ()          => request("GET", "/renewals"),
  decideRenewal:  (id, patch) => request("PATCH", `/renewals/${id}`, patch),
  sendRenewal:    (id)        => request("POST", `/renewals/${id}/send`),

  /* ---- notifications ---- */
  notifications: ()   => request("GET", "/notifications"),
  markRead:      (id) => request("POST", `/notifications/${id}/read`),

  /* ---- agreements ----
     The library holds files, not templates. Uploading takes multipart, and the
     file that comes back out is the file that went in. */
  agreements:      ()              => request("GET", "/agreements"),
  agreementReadiness: ()           => request("GET", "/agreements/readiness"),
  uploadAgreement(agreementId, file, meta = {}) {
    const fd = new FormData();
    fd.append("file", file);
    for (const [k, v] of Object.entries(meta)) if (v != null) fd.append(k, v);
    return request("POST", `/agreements/${agreementId}/versions`, fd);
  },
  approveAgreementVersion: (id, note) =>
    request("POST", `/agreements/versions/${id}/approve`, { approval_note: note }),
  withdrawAgreementVersion: (id, reason) =>
    request("POST", `/agreements/versions/${id}/withdraw`, { reason }),
  agreementFileUrl: (id) => `${BASE}/api/agreements/versions/${id}/file`,
  issueAgreement:  (payload)       => request("POST", "/agreements/issue", payload),
  sendAgreement:   (id)            => request("POST", `/agreements/issues/${id}/send`),
  markAgreementSigned: (id, note)  => request("POST", `/agreements/issues/${id}/signed`, { note }),
  agreementIssues: (q = "")        => request("GET", `/agreements/issues${q}`),

  /* ---- accounting document review ---- */
  accountingReviewCenter: () => request("GET", "/accounting/review-center"),
  createVendorInvoice: (payload) => request("POST", "/accounting/ap/invoices", payload),
  uploadAccountingDocument(type, id, file) {
    const fd = new FormData();
    fd.append("file", file);
    return request("POST", `/accounting/documents/${type}/${id}/upload`, fd);
  },
  generateAccountingDocument: (type, id) =>
    request("POST", `/accounting/documents/${type}/${id}/generate`, {}),
  reviewAccountingDocument: (type, id, decision, note = "", lane = null) =>
    request("POST", `/accounting/documents/${type}/${id}/review`, {
      decision, note, ...(lane ? { lane } : {}),
    }),
  generateMonthlyReports: (reports) =>
    request("POST", "/accounting/reports/batch", { reports }),
  updateMonthlyReport: (id, patch) =>
    request("PATCH", `/accounting/reports/${id}`, patch),
  accountingFileUrl: (id, download = false) =>
    `${BASE}/api/accounting/files/${id}${download ? "?download=1" : ""}`,

  /* ---- admin ---- */
  users:       ()            => request("GET", "/admin/users"),
  createUser:  (payload)     => request("POST", "/admin/users", payload),
  updateUser:  (id, patch)   => request("PATCH", `/admin/users/${id}`, patch),
  audit:       (q = "")      => request("GET", `/admin/audit${q}`),
  backups:     ()            => request("GET", "/admin/backups"),
  createBackup:()            => request("POST", "/admin/backups"),
  restore:     (id)          => request("POST", `/admin/backups/${id}/restore`),
  aiTraining:  (q = "")      => request("GET", `/admin/ai-training${q}`),
  reviewAiExample: (id, status, reason = "") =>
    request("PATCH", `/admin/ai-training/examples/${id}`, { status, reason }),
  createAiRule: (payload) => request("POST", "/admin/ai-training/rules", payload),
  updateAiRule: (id, patch) => request("PATCH", `/admin/ai-training/rules/${id}`, patch),
};

export default api;
