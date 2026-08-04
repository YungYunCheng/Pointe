/* ============================================================
   Baydo Pointe — shared i18n dictionary
   ------------------------------------------------------------
   The backend never sends prose. It sends message codes plus
   parameters; this file turns them into text in the reader's
   language. That way one notification row reads correctly for
   an English Admin and a Chinese Property Manager alike.

   Usage:
     import { createI18n, LOCALES } from "./baydo-i18n.js";
     const { t, locale, setLocale } = createI18n("en");
     t("login.title")                       -> "Sign in"
     t("err.NOTICE_TOO_SHORT", { lead: 6 }) -> "Only 6 hours' notice…"
   ============================================================ */

export const LOCALES = [
  { code: "en",      label: "English",  short: "EN" },
  { code: "zh-Hant", label: "繁體中文", short: "中" },
];

export const DEFAULT_LOCALE = "en";
export const STORAGE_KEY = "baydo:locale";

const DICT = {
  en: {
    /* ---------- common ---------- */
    "app.name": "Baydo Pointe",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.close": "Close",
    "common.back": "Back",
    "common.next": "Next",
    "common.search": "Search",
    "common.loading": "Loading…",
    "common.saving": "Saving…",
    "common.saved": "Saved",
    "common.saveFailed": "Save failed",
    "common.autosave": "Autosaves",
    "common.none": "None",
    "common.all": "All",
    "common.today": "Today",
    "common.tomorrow": "Tomorrow",
    "common.optional": "optional",
    "common.required": "required",
    "common.notSet": "Not set",
    "common.language": "Language",
    "common.signOut": "Sign out",

    /* ---------- roles ---------- */
    "role.admin": "Admin",
    "role.property_manager": "Property Manager",
    "role.building_manager": "Building Manager",

    /* ---------- login ---------- */
    "login.title": "Sign in",
    "login.subtitle": "Your account decides what you can see. Roles cannot be switched after signing in.",
    "login.email": "Email",
    "login.password": "Password",
    "login.show": "Show",
    "login.hide": "Hide",
    "login.submit": "Sign in",
    "login.checking": "Checking…",
    "login.forgot": "Forgot your password?",
    "login.signedIn": "Signed in",
    "login.signedInNote": "Your session is saved. The other tools will show what this role can access.",
    "login.changePassword": "Change password",
    "login.initialPassword": "This is still the initial password. Change it now using the reset flow.",

    /* ---------- forgot / reset ---------- */
    "forgot.title": "Forgot password",
    "forgot.help": "Enter your account email and we'll send a reset link.",
    "forgot.submit": "Send reset link",
    "forgot.backToLogin": "Back to sign in",
    "reset.title": "Reset password",
    "reset.code": "Reset code",
    "reset.codePlaceholder": "Paste the reset code",
    "reset.new": "New password",
    "reset.again": "Enter it again",
    "reset.submit": "Set new password",
    "reset.devTitle": "Prototype only: the reset code is shown here",
    "reset.devNote": "In production this goes inside an emailed link and never appears on screen.",
    "reset.validUntil": "Valid until {at}",
    "reset.sentIfExists": "If that email has an account, a reset link has been sent. It expires in 30 minutes.",
    "reset.done": "Password updated. Sign in with the new one.",

    /* ---------- password rules ---------- */
    "pw.MIN_LENGTH_10": "At least 10 characters",
    "pw.NEEDS_LOWERCASE": "One lowercase letter",
    "pw.NEEDS_UPPERCASE": "One uppercase letter",
    "pw.NEEDS_DIGIT": "One number",
    "pw.NEEDS_SYMBOL": "One symbol",

    /* ---------- server message codes ---------- */
    "err.NOT_AUTHENTICATED": "You are not signed in.",
    "err.SESSION_INVALID": "This session is no longer valid.",
    "err.SESSION_EXPIRED": "Your session has expired. Please sign in again.",
    "err.ACCOUNT_DISABLED": "This account has been disabled.",
    "err.FORBIDDEN": "Your role does not have access to this.",
    "err.MISSING_CREDENTIALS": "Enter both an email and a password.",
    "err.INVALID_CREDENTIALS": "Email or password is incorrect.",
    "err.ACCOUNT_LOCKED": "Too many attempts. This account is locked until {locked_until}.",
    "err.TOO_MANY_ATTEMPTS": "Too many attempts. Try again shortly.",
    "err.WEAK_PASSWORD": "That password does not meet the rules.",
    "err.PASSWORD_REUSED": "The new password must be different from the current one.",
    "err.CURRENT_PASSWORD_WRONG": "Current password is incorrect.",
    "err.RESET_TOKEN_INVALID": "That reset code is not valid or has already been used.",
    "err.RESET_TOKEN_EXPIRED": "That reset code has expired. Request a new one.",
    "err.UNSUPPORTED_LOCALE": "That language is not supported.",
    "err.UNIT_NOT_FOUND": "No such unit.",
    "err.UNIT_NOT_AVAILABLE": "This unit is {status_now}, so signing cannot start.",
    "err.UNIT_ALREADY_TAKEN": "{holder} started signing this unit at {since}. First to sign wins — offer another available unit.",
    "err.LOCK_NOT_YOURS": "That lock belongs to someone else.",
    "err.POOL_NOT_FOUND": "No such parking area.",
    "err.INVALID_STALL_COUNT": "That stall count is not valid.",
    "err.QUOTA_BELOW_ASSIGNED": "{assigned} stalls are already assigned; the total cannot go below that.",
    "err.UNIT_STALL_LIMIT_REACHED": "This unit already holds its limit of {limit} stall(s).",
    "err.ALREADY_RELEASED": "This stall has already been released.",
    "err.MOVEOUT_NOT_FOUND": "No such move-out.",
    "err.ALREADY_VACATED": "This move-out is already marked as vacated.",
    "err.UPHELD_REQUIRES_BASIS": "Upholding a disputed deduction requires a written basis.",
    "err.UPHELD_REQUIRES_EVIDENCE": "Upload evidence before upholding a disputed deduction. Without it the deduction will not hold up.",
    "err.NOTICE_TOO_SHORT": "Only {lead_hours} hours' notice — {required_hours} are required. Reschedule rather than sending it anyway.",
    "err.RENEWAL_NO_DECISION": "Choose a renewal outcome first.",
    "err.RENEWAL_NOTICE_NOT_REVIEWED": "The notice has not been reviewed yet.",
    "err.INCREASE_TOO_SOON": "Only {days} days since the tenancy started or the last increase. An increase needs 365.",
    "err.EMAIL_TAKEN": "That email already has an account.",
    "err.CANNOT_MODIFY_SELF": "You cannot change your own role or disable yourself.",
    "err.SERVER_ERROR": "Something went wrong on the server.",

    /* ---------- notifications ---------- */
    "note.MOVEOUT_NOTICE_OK": "{unit}: notice period is {given} days, which meets the {required} required.",
    "note.MOVEOUT_NOTICE_SHORT": "{unit}: notice period is only {given} days against {required} required. Decide how to handle it.",
    "note.MOVEOUT_SHOWINGS_MAY_START": "{unit} can be shown now. Tenant moves out {moveout_date}; the unit is still occupied, so send a notice of entry {hours} hours ahead.",
    "note.UNIT_VACATED": "{unit} is empty. Arrange cleaning and repairs, then set it back to available.",
    "note.VENDOR_VISIT_SCHEDULED": "{unit}: vendor visit booked for {at}. If the unit is occupied, send a notice of entry {hours} hours ahead.",
    "note.LEASE_EXPIRING": "{unit}: lease ends {end_date}, {days} days away. Decide whether to renew on a fixed term, convert to month-to-month, or not renew.",
    "note.EVENT_REMINDER": "{type} at {unit}, {at}.",
    "note.REFUND_DEADLINE": "{unit}: deposit refund due {deadline}.",
    "note.INCREASE_TOO_SOON": "Rent cannot be increased yet — only {days} days since the last increase or the start of tenancy.",
    "note.INCREASE_PERIODIC_NOTICE": "A month-to-month tenancy needs {months} months' written notice before an increase takes effect.",
    "note.INCREASE_AT_NEW_TERM": "An increase can take effect at the start of the new term.",

    /* ---------- units and parking ---------- */
    "unit.status.available": "Available",
    "unit.status.signed": "Signed, awaiting move-in",
    "unit.status.occupied": "Occupied",
    "unit.status.turnover": "Turnover",
    "unit.status.offline": "Offline",
    "parking.assigned": "Assigned",
    "parking.waiting": "Waitlisted",
    "parking.free": "{n} free",
    "parking.full": "Full",
    "parking.firstComeNote": "First come, first served. The request time is the only thing that decides the order.",

    /* ---------- legal reminders ---------- */
    "legal.depositCap": "Alberta caps the security deposit at one month's rent, and a pet deposit counts inside that cap.",
    "legal.inspections": "Move-in and move-out inspection reports are required. Without them a deposit dispute is hard to defend.",
    "legal.wearAndTear": "Normal wear and tear cannot be deducted. This is the most common point of dispute.",
    "legal.noRTB": "Alberta has no RTB and no government rent-increase form — that is British Columbia. Use your own approved template.",
    "legal.protectedGrounds": "Screening or prioritising by income source, family status, nationality or other protected grounds is prohibited.",
    "legal.confirm": "Confirm the exact figures with your manager before relying on them.",
  },

  "zh-Hant": {
    /* ---------- 共用 ---------- */
    "app.name": "Baydo Pointe",
    "common.save": "儲存",
    "common.cancel": "取消",
    "common.confirm": "確認",
    "common.delete": "刪除",
    "common.edit": "編輯",
    "common.close": "關閉",
    "common.back": "返回",
    "common.next": "下一步",
    "common.search": "搜尋",
    "common.loading": "讀取中…",
    "common.saving": "儲存中…",
    "common.saved": "已儲存",
    "common.saveFailed": "儲存失敗",
    "common.autosave": "自動儲存",
    "common.none": "無",
    "common.all": "全部",
    "common.today": "今天",
    "common.tomorrow": "明天",
    "common.optional": "選填",
    "common.required": "必填",
    "common.notSet": "尚未設定",
    "common.language": "語言",
    "common.signOut": "登出",

    /* ---------- 角色 ---------- */
    "role.admin": "Admin",
    "role.property_manager": "Property Manager",
    "role.building_manager": "Building Manager",

    /* ---------- 登入 ---------- */
    "login.title": "登入",
    "login.subtitle": "功能依帳號的角色決定，登入後不能切換。",
    "login.email": "Email",
    "login.password": "密碼",
    "login.show": "顯示",
    "login.hide": "隱藏",
    "login.submit": "登入",
    "login.checking": "驗證中…",
    "login.forgot": "忘記密碼？",
    "login.signedIn": "已登入",
    "login.signedInNote": "登入狀態已儲存，其他工具會依這個角色顯示功能。",
    "login.changePassword": "變更密碼",
    "login.initialPassword": "這是初始密碼，建議立刻透過重設流程改掉。",

    /* ---------- 忘記與重設 ---------- */
    "forgot.title": "忘記密碼",
    "forgot.help": "輸入帳號 Email，系統會寄出重設連結。",
    "forgot.submit": "寄出重設連結",
    "forgot.backToLogin": "回到登入",
    "reset.title": "重設密碼",
    "reset.code": "重設碼",
    "reset.codePlaceholder": "貼上重設碼",
    "reset.new": "新密碼",
    "reset.again": "再輸入一次",
    "reset.submit": "設定新密碼",
    "reset.devTitle": "原型模擬：這裡直接顯示重設碼",
    "reset.devNote": "正式系統會把這串放進寄給使用者的連結，畫面上不會出現。",
    "reset.validUntil": "有效至 {at}",
    "reset.sentIfExists": "如果這個 Email 有對應的帳號，重設連結已寄出，30 分鐘內有效。",
    "reset.done": "密碼已更新，請用新密碼登入。",

    /* ---------- 密碼規則 ---------- */
    "pw.MIN_LENGTH_10": "至少 10 個字元",
    "pw.NEEDS_LOWERCASE": "含小寫字母",
    "pw.NEEDS_UPPERCASE": "含大寫字母",
    "pw.NEEDS_DIGIT": "含數字",
    "pw.NEEDS_SYMBOL": "含符號",

    /* ---------- 伺服器訊息代碼 ---------- */
    "err.NOT_AUTHENTICATED": "尚未登入。",
    "err.SESSION_INVALID": "登入階段已失效。",
    "err.SESSION_EXPIRED": "登入已過期，請重新登入。",
    "err.ACCOUNT_DISABLED": "此帳號已停用。",
    "err.FORBIDDEN": "你的角色沒有這項權限。",
    "err.MISSING_CREDENTIALS": "請輸入帳號與密碼。",
    "err.INVALID_CREDENTIALS": "帳號或密碼錯誤。",
    "err.ACCOUNT_LOCKED": "嘗試次數過多，帳號鎖定至 {locked_until}。",
    "err.TOO_MANY_ATTEMPTS": "嘗試次數過多，請稍後再試。",
    "err.WEAK_PASSWORD": "密碼不符合規則。",
    "err.PASSWORD_REUSED": "新密碼不能與目前密碼相同。",
    "err.CURRENT_PASSWORD_WRONG": "目前密碼不正確。",
    "err.RESET_TOKEN_INVALID": "重設碼無效或已使用。",
    "err.RESET_TOKEN_EXPIRED": "重設碼已過期，請重新申請。",
    "err.UNSUPPORTED_LOCALE": "不支援這個語言。",
    "err.UNIT_NOT_FOUND": "查無此單位。",
    "err.UNIT_NOT_AVAILABLE": "此單位狀態為 {status_now}，不能開始簽約。",
    "err.UNIT_ALREADY_TAKEN": "{holder} 已於 {since} 開始這一戶的簽約流程。全案先簽先得，請改推薦其他可租單位。",
    "err.LOCK_NOT_YOURS": "這個鎖不是你持有的。",
    "err.POOL_NOT_FOUND": "查無此車位區。",
    "err.INVALID_STALL_COUNT": "車位數不正確。",
    "err.QUOTA_BELOW_ASSIGNED": "已配出 {assigned} 位，總數不能低於此數。",
    "err.UNIT_STALL_LIMIT_REACHED": "此單位已達每戶上限 {limit} 位。",
    "err.ALREADY_RELEASED": "這個車位已經釋出了。",
    "err.MOVEOUT_NOT_FOUND": "查無此遷出流程。",
    "err.ALREADY_VACATED": "已經確認過搬離了。",
    "err.UPHELD_REQUIRES_BASIS": "維持有爭議的扣款必須填寫書面依據。",
    "err.UPHELD_REQUIRES_EVIDENCE": "維持有爭議的扣款前請先上傳證據。沒有證據的扣款站不住腳。",
    "err.NOTICE_TOO_SHORT": "距進入僅 {lead_hours} 小時，不足 {required_hours} 小時。請改期，不要硬發通知。",
    "err.RENEWAL_NO_DECISION": "請先做出續約決定。",
    "err.RENEWAL_NOTICE_NOT_REVIEWED": "通知內容尚未審核。",
    "err.INCREASE_TOO_SOON": "距起租或上次調漲僅 {days} 天，未滿 365 天不得調漲。",
    "err.EMAIL_TAKEN": "這個 Email 已經有帳號。",
    "err.CANNOT_MODIFY_SELF": "不能改自己的角色，也不能停用自己。",
    "err.SERVER_ERROR": "伺服器發生錯誤。",

    /* ---------- 通知 ---------- */
    "note.MOVEOUT_NOTICE_OK": "{unit} 通知期 {given} 天，符合要求的 {required} 天。",
    "note.MOVEOUT_NOTICE_SHORT": "{unit} 通知期只有 {given} 天，低於要求的 {required} 天，需確認如何處理。",
    "note.MOVEOUT_SHOWINGS_MAY_START": "{unit} 可以開始帶看。租客預計 {moveout_date} 遷出，單位仍有人住，帶看前須提前 {hours} 小時發入內通知。",
    "note.UNIT_VACATED": "{unit} 已搬空，請安排清潔與修繕，完成後改回可租。",
    "note.VENDOR_VISIT_SCHEDULED": "{unit} 廠商到場已排入 {at}。單位有人住的話，記得提前 {hours} 小時發入內通知。",
    "note.LEASE_EXPIRING": "{unit} 租約 {end_date} 到期，還有 {days} 天。請決定續固定期、轉逐月，或不續約。",
    "note.EVENT_REMINDER": "{at} 在 {unit} 有 {type}。",
    "note.REFUND_DEADLINE": "{unit} 押金退還期限 {deadline}。",
    "note.INCREASE_TOO_SOON": "目前不得調漲——距上次調漲或起租僅 {days} 天。",
    "note.INCREASE_PERIODIC_NOTICE": "逐月租約調漲須提前 {months} 個月書面通知才生效。",
    "note.INCREASE_AT_NEW_TERM": "可於新約起始日調整。",

    /* ---------- 單位與車位 ---------- */
    "unit.status.available": "可租",
    "unit.status.signed": "已簽約待入住",
    "unit.status.occupied": "已入住",
    "unit.status.turnover": "整備中",
    "unit.status.offline": "停用",
    "parking.assigned": "已配位",
    "parking.waiting": "候補中",
    "parking.free": "剩 {n} 位",
    "parking.full": "已額滿",
    "parking.firstComeNote": "先到先得，順序完全依登記時間決定。",

    /* ---------- 法規提醒 ---------- */
    "legal.depositCap": "Alberta 規定保證金上限為一個月租金，寵物押金須計入這個上限。",
    "legal.inspections": "入住與遷出檢查報告為必備，缺少會影響押金爭議時的舉證。",
    "legal.wearAndTear": "正常耗損不可扣除，這是押金爭議最常見的爭點。",
    "legal.noRTB": "Alberta 沒有 RTB，也沒有政府指定的漲租表格——那是 BC。請用你們自己核定的範本。",
    "legal.protectedGrounds": "不得以收入來源、家庭狀態、國籍等受保護特徵作為篩選或排序依據。",
    "legal.confirm": "實際數字請向經理確認後再據以執行。",
  },
};

/* ---------- helpers ---------- */

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m));
}

/** Translate a key. Falls back to English, then to the key itself, so a missing
 *  string shows up as an obvious identifier rather than silently blank. */
export function translate(locale, key, params) {
  const table = DICT[locale] ?? DICT[DEFAULT_LOCALE];
  const val = table[key] ?? DICT[DEFAULT_LOCALE][key];
  if (val == null) return key;
  return interpolate(val, params);
}

/** Render a server response that carries { code, ...params }. */
export function serverMessage(locale, payload, prefix = "err") {
  if (!payload) return translate(locale, `${prefix}.SERVER_ERROR`);
  const { code, ...rest } = payload;
  return translate(locale, `${prefix}.${code}`, rest);
}

export function createI18n(initial = DEFAULT_LOCALE) {
  let locale = DICT[initial] ? initial : DEFAULT_LOCALE;
  return {
    get locale() { return locale; },
    setLocale(next) { if (DICT[next]) locale = next; },
    t: (key, params) => translate(locale, key, params),
    msg: (payload, prefix) => serverMessage(locale, payload, prefix),
  };
}

/** Locale-aware formatting. Currency stays CAD in both languages. */
export const fmtMoney = (locale, n) =>
  n == null || isNaN(n) ? "—"
    : new Intl.NumberFormat(locale === "zh-Hant" ? "zh-Hant-CA" : "en-CA",
        { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(n);

export const fmtDate = (locale, iso) =>
  !iso ? "—" : new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-Hant-CA" : "en-CA",
    { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso));

export const fmtDateTime = (locale, iso) =>
  !iso ? "—" : new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-Hant-CA" : "en-CA",
    { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default DICT;
