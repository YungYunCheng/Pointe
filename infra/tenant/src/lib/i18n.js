/* ============================================================
   Tenant-facing copy, English and Traditional Chinese.

   Everything here is read by a tenant, so both languages are
   required. The staff tools are English only and do not use this.

   Language follows the tenant: their saved choice, otherwise the
   browser. A Chinese-speaking tenant should not have to hunt for a
   switch on arrival.
   ============================================================ */

export const LOCALES = [
  { code: "en", label: "English", short: "EN" },
  { code: "zh", label: "繁體中文", short: "中文" },
];

const D = {
  en: {
    "nav.home": "Home", "nav.suites": "Suites", "nav.building": "The buildings",
    "nav.apply": "Apply", "nav.portal": "Tenant portal", "nav.signin": "Sign in",
    "nav.signout": "Sign out", "nav.book": "Book a viewing",

    "home.address": "370 · 374 · 378 Clareview Station Drive NW, Edmonton",
    "home.headline": "A short walk from Clareview LRT.",
    "home.sub": "330 suites across three buildings. One and two bedrooms, most with a 71 ft² balcony, and a gym, lounge and pet wash in every building.",
    "home.cta": "See what is available",
    "home.ctaSecond": "Book a viewing",
    "home.availableNow": "{n} suites available now",
    "home.checking": "Checking availability…",
    "home.fromRent": "From {rent} a month",
    "home.noPricing": "Ask us for current rates",

    "amen.title": "In every building",
    "amen.gym": "Gym", "amen.lounge": "Lounge and games room", "amen.petwash": "Pet wash",
    "amen.bike": "Secure bike storage", "amen.patio": "Outdoor patio",
    "amen.transit": "Beside Clareview LRT", "amen.parking": "Underground and surface parking",
    "amen.busPad": "Bus stop at the door",

    "suites.title": "Suites",
    "suites.sub": "Live availability. Rents shown are current, and every cost is set out in full before you sign anything.",
    "suites.filterAll": "All", "suites.filter1": "1 bedroom", "suites.filter2": "2 bedroom",
    "suites.filterDen": "With a den",
    "suites.available": "{n} available", "suites.none": "None right now",
    "suites.sqft": "{n} ft²", "suites.balcony": "71 ft² balcony",
    "suites.perMonth": "/month", "suites.askRate": "Ask us",
    "suites.earliest": "Earliest move-in {date}",
    "suites.book": "Book a viewing", "suites.apply": "Apply for this suite",
    "suites.empty": "Nothing is listed at the moment. Send us a message and we will tell you what is coming up.",

    "parking.title": "Parking",
    "parking.body": "There are fewer stalls than suites, so parking is first come, first served and there is often a waitlist. We will tell you exactly where you stand before you sign, not after.",
    "parking.free": "{n} stalls free today", "parking.waitlist": "{n} on the waitlist",
    "parking.none": "No stalls free today",

    "pets.title": "Pets",
    "pets.limit": "Limit: {limit}", "pets.noLimit": "Ask us about the pet policy",
    "pets.deposit": "A pet deposit counts inside the security deposit, so it is not charged on top.",
    "pets.service": "Service animals are not pets and none of the above applies to them. Tell us what you need and we will sort it out.",

    "book.title": "Book a viewing",
    "book.sub": "Pick a time that suits you. We will confirm by email.",
    "book.suite": "Which suite?", "book.anySuite": "Not sure yet",
    "book.pickDay": "Choose a day", "book.pickTime": "Choose a time",
    "book.noSlots": "No times left on this day",
    "book.name": "Your name", "book.email": "Email", "book.phone": "Phone",
    "book.notes": "Anything we should know (optional)",
    "book.submit": "Book it", "book.booking": "Booking…",
    "book.doneTitle": "You are booked in",
    "book.doneBody": "{date} at {time}, suite {unit}. A confirmation is on its way to {email}.",
    "book.reschedule": "Need to change it? Reply to the confirmation email.",
    "book.occupied": "This suite still has a tenant in it, so we give them 24 hours' notice before any viewing. That is why the earliest times are a day or two out.",

    "apply.title": "Apply", "apply.sub": "Six steps, about ten minutes. You can stop and come back.",
    "apply.step": "Step {n} of {total}",
    "apply.next": "Continue", "apply.back": "Back",
    "apply.submit": "Submit application", "apply.submitting": "Submitting…",

    "apply.s1": "The suite", "apply.s1sub": "Which one, and when would you move in?",
    "apply.moveIn": "Preferred move-in date", "apply.term": "How long?",
    "apply.term12": "12 months", "apply.term6": "6 months", "apply.termMonthly": "Month to month",

    "apply.s2": "About you", "apply.s2sub": "Just the people who will be on the lease.",
    "apply.fullName": "Full name", "apply.addTenant": "Add another adult on the lease",
    "apply.occupants": "How many people will live here?",
    "apply.occupantsHint": "Including children. We ask because of occupancy limits, and for no other reason.",

    "apply.s3": "Parking, storage and pets", "apply.s3sub": "All optional, and all can change later.",
    "apply.wantParking": "Do you need a parking stall?",
    "apply.wantStorage": "Do you want a storage locker?",
    "apply.pets": "Any pets?", "apply.petsNone": "No pets",
    "apply.petCat": "Cat", "apply.petDog": "Dog", "apply.petBoth": "Cat and dog",
    "apply.serviceAnimal": "I have a service animal",
    "apply.serviceNote": "A service animal is not a pet. There is no pet deposit and no pet rent, and we will contact you directly about what you need.",

    "apply.s4": "What it costs", "apply.s4sub": "Every figure, before you go any further. Nothing is added later.",
    "apply.monthly": "Every month", "apply.upfront": "At move-in",
    "apply.monthlyTotal": "Monthly total", "apply.upfrontTotal": "Due at move-in",
    "apply.rentIncludes": "Rent includes",
    "apply.depositNote": "The security deposit cannot exceed one month's rent, and a pet deposit counts inside that.",
    "apply.leaseGoverns": "These figures are set out in the lease, which is what governs.",
    "apply.ack": "I have read the costs above",

    "apply.s5": "Documents", "apply.s5sub": "You can send these later if you would rather.",
    "apply.upload": "Add a file", "apply.uploaded": "{n} file(s) added",
    "apply.docHint": "Photo ID, and something showing you can cover the rent. If you would rather not upload anything here, say so and we will arrange it another way.",
    "apply.skipDocs": "I will send these separately",

    "apply.s6": "Check and send", "apply.s6sub": "Have a look before it goes.",
    "apply.editStep": "Change",
    "apply.consent": "I agree that Baydo Development may use this information to process my application.",
    "apply.consentNote": "We keep it only as long as we need it, and never share it beyond what processing your application requires.",
    "apply.doneTitle": "Application received",
    "apply.doneBody": "Reference {ref}. Someone will be in touch within one business day.",
    "apply.doneNext": "Nothing is committed yet. We will confirm the suite and the costs before anything is signed.",

    "portal.title": "Tenant portal",
    "portal.signInSub": "Book a viewing, apply for a suite, and follow how it is going. Already renting here? Your suite appears once your lease is signed.",
    "portal.email": "Email", "portal.password": "Password", "portal.signIn": "Sign in",
    "portal.forgot": "Forgot your password?",
    "portal.firstTime": "First time? Use the link in your welcome email to set a password.",
    "portal.badCredentials": "That email and password do not match. Check both, or reset your password.",
    "portal.locked": "Too many attempts. Try again after {until}.",
    "portal.resetSent": "If that email is on file, a reset link is on its way.",
    "portal.emailFirst": "Enter your email first.",
    "portal.signin": "Sign in",
    "portal.signingIn": "Signing in…",
    "portal.newHeading": "New here?",
    "portal.newBody": "Create an account and you can:",
    "portal.newBook": "Book a viewing at a time that suits you",
    "portal.newApply": "Apply for a suite online",
    "portal.newTrack": "See where your application has got to",
    "portal.alreadyTenant": "Already renting here? Create an account the same way — we connect it to your suite when your lease is signed.",
    "gate.hint": "Sign in or create an account to book",
    "gate.heading": "Create an account first",
    "gate.body": "Booking a viewing takes a minute and we need somewhere to send the confirmation. Your account also keeps your applications in one place.",
    "portal.firstTimeHeading": "First time here?",
    "portal.firstTimeBody": "Create an account to book a viewing or apply. If you already rent here, we connect it to your suite when the lease is signed.",
    "portal.setUp": "Create an account",
    "portal.tabViewings": "Viewings",
    "portal.tabApplications": "Applications",
    "portal.tabSign": "To sign",
    "portal.hello": "Hello, {name}", "portal.yourSuite": "Suite {unit}",
    "portal.tabHome": "Overview", "portal.tabRepairs": "Repairs", "portal.tabNotices": "Notices",
    "portal.tabRent": "Rent", "portal.tabDocs": "Documents",
    "portal.leaseEnds": "Lease ends {date}", "portal.leaseMonthly": "Month to month",
    "portal.parkingStall": "Parking: {pool}", "portal.noParking": "No parking stall",
    "portal.onWaitlist": "On the parking waitlist, position {n}",

    "repairs.title": "Repairs", "repairs.new": "Report something",
    "repairs.none": "Nothing open.",
    "repairs.what": "What is wrong?", "repairs.where": "Where in the suite?",
    "repairs.urgentQ": "Is anything unsafe, leaking, or is there no heat or hot water?",
    "repairs.urgentYes": "Yes", "repairs.urgentNo": "No",
    "repairs.urgentCall": "Please call the office on {phone} rather than waiting here. We will still log this, but a phone call gets someone moving now.",
    "repairs.entryConsent": "We may need to enter your suite. We will give you 24 hours' written notice with a time window, unless it is an emergency.",
    "repairs.photos": "Add photos (helps a lot)", "repairs.submit": "Send it",
    "repairs.statusNew": "Received", "repairs.statusScheduled": "Scheduled",
    "repairs.statusProgress": "In progress", "repairs.statusDone": "Done",
    "repairs.scheduledFor": "Someone is coming {date}", "repairs.rush": "Marked urgent",

    "notices.title": "Notices", "notices.none": "Nothing right now.",
    "notices.entry": "Notice of entry",
    "notices.entryBody": "{date}, between {from} and {to}. Reason: {reason}.",
    "notices.entryReschedule": "If that time does not work, reply and we will find another.",

    "rent.title": "Rent", "rent.amount": "{amount} a month",
    "rent.dueOn": "Due on the {day} of each month", "rent.payLink": "Pay rent",
    "rent.external": "Payments are handled by our accounting system. You will be taken there.",
    "rent.breakdown": "What makes up your monthly total",

    "docs.title": "Documents", "docs.none": "Nothing here yet.",
    "docs.lease": "Your lease", "docs.inspection": "Move-in inspection report",
    "docs.receipt": "Deposit receipt", "docs.download": "Download",

    "common.optional": "optional", "common.required": "required",
    "common.loading": "Loading…", "common.error": "Something went wrong. Try again, or send us a message.",
    "common.close": "Close", "common.yes": "Yes", "common.no": "No",
    "common.contact": "Contact us", "common.privacy": "Privacy",
    "common.office": "Office", "common.emergency": "Emergency",
    "footer.legal": "Baydo Development Corporation. Suite sizes and layouts are approximate; the signed lease governs.",
    "footer.fairHousing": "We rent to anyone who meets our written criteria. We do not ask about, or take into account, your family, nationality, religion, age, or where your income comes from.",
  },

  zh: {
    "nav.home": "首頁", "nav.suites": "房型", "nav.building": "社區環境",
    "nav.apply": "線上申請", "nav.portal": "住戶專區", "nav.signin": "登入",
    "nav.signout": "登出", "nav.book": "預約看房",

    "home.address": "370 · 374 · 378 Clareview Station Drive NW, Edmonton",
    "home.headline": "走路就到 Clareview 輕軌站。",
    "home.sub": "三棟樓共 330 戶。一房與兩房格局，多數附 71 平方呎陽台，每棟都有健身房、Lounge 和寵物清洗間。",
    "home.cta": "看看有哪些空房",
    "home.ctaSecond": "預約看房",
    "home.availableNow": "目前有 {n} 戶可租",
    "home.checking": "查詢空房中…",
    "home.fromRent": "月租 {rent} 起",
    "home.noPricing": "租金請洽詢我們",

    "amen.title": "每棟都有",
    "amen.gym": "健身房", "amen.lounge": "Lounge 與遊戲室", "amen.petwash": "寵物清洗間",
    "amen.bike": "自行車儲藏室", "amen.patio": "戶外露台",
    "amen.transit": "緊鄰 Clareview 輕軌站", "amen.parking": "地下與地面停車位",
    "amen.busPad": "門口就有公車站",

    "suites.title": "房型",
    "suites.sub": "即時空房狀況。這裡的租金就是現在的價格，簽約前我們會把所有費用完整列給你。",
    "suites.filterAll": "全部", "suites.filter1": "一房", "suites.filter2": "兩房",
    "suites.filterDen": "含書房",
    "suites.available": "{n} 戶可租", "suites.none": "目前額滿",
    "suites.sqft": "{n} 平方呎", "suites.balcony": "71 平方呎陽台",
    "suites.perMonth": "／月", "suites.askRate": "請洽詢",
    "suites.earliest": "最早可入住 {date}",
    "suites.book": "預約看房", "suites.apply": "申請這一戶",
    "suites.empty": "目前沒有刊登中的房源。傳訊息給我們，可以先告訴你近期會空出哪些。",

    "parking.title": "停車位",
    "parking.body": "車位數少於戶數，所以採先到先得，經常需要候補。我們會在簽約前就明確告訴你目前的順位，不會等到簽完才說。",
    "parking.free": "今天還有 {n} 個車位", "parking.waitlist": "候補中 {n} 位",
    "parking.none": "今天沒有空車位",

    "pets.title": "寵物",
    "pets.limit": "上限：{limit}", "pets.noLimit": "寵物政策請洽詢我們",
    "pets.deposit": "寵物押金已包含在保證金總額內，不會額外加收。",
    "pets.service": "服務動物不屬於寵物，上述規定都不適用。請告訴我們你的需求，我們會另行安排。",

    "book.title": "預約看房",
    "book.sub": "選一個方便的時間，我們會用 Email 跟你確認。",
    "book.suite": "想看哪一戶？", "book.anySuite": "還沒決定",
    "book.pickDay": "選日期", "book.pickTime": "選時段",
    "book.noSlots": "這天已經沒有時段了",
    "book.name": "你的姓名", "book.email": "Email", "book.phone": "電話",
    "book.notes": "有什麼想先讓我們知道的（選填）",
    "book.submit": "確認預約", "book.booking": "預約中…",
    "book.doneTitle": "已為你預約",
    "book.doneBody": "{date} {time}，{unit}。確認信正在寄到 {email}。",
    "book.reschedule": "需要改時間的話，回覆確認信就可以。",
    "book.occupied": "這一戶目前還有租客住著，帶看前我們會提前 24 小時書面通知他，所以最早的時段會在一兩天後。",

    "apply.title": "線上申請", "apply.sub": "六個步驟，大約十分鐘。中途可以離開，之後再回來。",
    "apply.step": "第 {n} 步，共 {total} 步",
    "apply.next": "繼續", "apply.back": "上一步",
    "apply.submit": "送出申請", "apply.submitting": "送出中…",

    "apply.s1": "選擇單位", "apply.s1sub": "想租哪一戶，什麼時候搬進來？",
    "apply.moveIn": "希望入住日", "apply.term": "打算租多久？",
    "apply.term12": "12 個月", "apply.term6": "6 個月", "apply.termMonthly": "逐月",

    "apply.s2": "你的資料", "apply.s2sub": "只需要會列在租約上的人。",
    "apply.fullName": "姓名全名", "apply.addTenant": "新增另一位承租人",
    "apply.occupants": "總共會有幾個人住？",
    "apply.occupantsHint": "含未成年人。我們問這個只是因為居住人數上限的規定，沒有其他用途。",

    "apply.s3": "車位、儲藏室與寵物", "apply.s3sub": "都是選填，之後也可以再調整。",
    "apply.wantParking": "需要車位嗎？",
    "apply.wantStorage": "需要儲藏室嗎？",
    "apply.pets": "有養寵物嗎？", "apply.petsNone": "沒有",
    "apply.petCat": "貓", "apply.petDog": "狗", "apply.petBoth": "貓和狗",
    "apply.serviceAnimal": "我有服務動物",
    "apply.serviceNote": "服務動物不算寵物，沒有寵物押金也沒有寵物月費。我們會直接跟你聯絡了解需求。",

    "apply.s4": "費用明細", "apply.s4sub": "所有數字先讓你看清楚，之後不會再冒出別的。",
    "apply.monthly": "每月固定", "apply.upfront": "入住時一次性",
    "apply.monthlyTotal": "每月合計", "apply.upfrontTotal": "入住時應付",
    "apply.rentIncludes": "租金包含",
    "apply.depositNote": "保證金不得超過一個月租金，寵物押金也計入這個上限之內。",
    "apply.leaseGoverns": "這些金額會寫進租約，以租約為準。",
    "apply.ack": "我已閱讀以上費用",

    "apply.s5": "文件", "apply.s5sub": "現在不方便的話，之後再補也可以。",
    "apply.upload": "選擇檔案", "apply.uploaded": "已加入 {n} 個檔案",
    "apply.docHint": "身分證明，以及可以支付租金的佐證。如果不想在這裡上傳，跟我們說一聲，我們用其他方式處理。",
    "apply.skipDocs": "我之後另外提供",

    "apply.s6": "確認並送出", "apply.s6sub": "送出前再看一次。",
    "apply.editStep": "修改",
    "apply.consent": "我同意 Baydo Development 使用這些資料處理我的申請。",
    "apply.consentNote": "我們只保留處理申請所需的期間，也不會超出這個範圍分享出去。",
    "apply.doneTitle": "已收到你的申請",
    "apply.doneBody": "編號 {ref}。同事會在一個工作天內跟你聯絡。",
    "apply.doneNext": "目前還沒有任何約束。單位和費用我們都會再跟你確認過，才會進到簽約。",

    "portal.title": "住戶專區",
    "portal.signInSub": "預約看房、送出申請、追蹤進度。已經住在這裡的話，簽約後就會看到你的單位。",
    "portal.email": "Email", "portal.password": "密碼", "portal.signIn": "登入",
    "portal.forgot": "忘記密碼？",
    "portal.firstTime": "第一次使用？請點歡迎信裡的連結設定密碼。",
    "portal.badCredentials": "Email 或密碼不正確。請確認後再試，或重設密碼。",
    "portal.locked": "嘗試次數過多，請於 {until} 後再試。",
    "portal.resetSent": "如果這個 Email 在我們的紀錄中，重設連結已經寄出。",
    "portal.emailFirst": "請先填入 Email。",
    "portal.signin": "登入",
    "portal.signingIn": "登入中…",
    "portal.newHeading": "第一次來？",
    "portal.newBody": "建立帳號之後就可以：",
    "portal.newBook": "挑一個方便的時間預約看房",
    "portal.newApply": "線上送出租屋申請",
    "portal.newTrack": "隨時查看申請進度",
    "portal.alreadyTenant": "已經住在這裡了？一樣建立帳號就好——簽約時我們會把它接上你的單位。",
    "gate.hint": "登入或建立帳號才能預約",
    "gate.heading": "先建立一個帳號",
    "gate.body": "預約看房只要一分鐘，我們需要一個地方把確認信寄給你。帳號也會把你的申請都放在同一個地方。",
    "portal.firstTimeHeading": "第一次使用？",
    "portal.firstTimeBody": "建立帳號就可以預約看房或送申請。已經是住戶的話，簽約時我們會把帳號接上你的單位。",
    "portal.setUp": "建立帳號",
    "portal.tabViewings": "看房預約",
    "portal.tabApplications": "申請",
    "portal.tabSign": "待簽署",
    "portal.hello": "你好，{name}", "portal.yourSuite": "{unit}",
    "portal.tabHome": "總覽", "portal.tabRepairs": "報修", "portal.tabNotices": "通知",
    "portal.tabRent": "租金", "portal.tabDocs": "文件",
    "portal.leaseEnds": "租約至 {date}", "portal.leaseMonthly": "逐月租約",
    "portal.parkingStall": "車位：{pool}", "portal.noParking": "尚未配到車位",
    "portal.onWaitlist": "車位候補中，目前第 {n} 順位",

    "repairs.title": "報修", "repairs.new": "我要報修",
    "repairs.none": "目前沒有進行中的項目。",
    "repairs.what": "哪裡出了問題？", "repairs.where": "在家裡的哪個位置？",
    "repairs.urgentQ": "是否有安全疑慮、漏水，或者沒有暖氣、沒有熱水？",
    "repairs.urgentYes": "是", "repairs.urgentNo": "否",
    "repairs.urgentCall": "請直接打 {phone} 到辦公室，不要在這裡等。我們一樣會記錄，但打電話才能馬上有人處理。",
    "repairs.entryConsent": "我們可能需要進入你的單位。除緊急情況外，會提前 24 小時書面通知並註明時間區間。",
    "repairs.photos": "附上照片（很有幫助）", "repairs.submit": "送出",
    "repairs.statusNew": "已收到", "repairs.statusScheduled": "已排定",
    "repairs.statusProgress": "處理中", "repairs.statusDone": "已完成",
    "repairs.scheduledFor": "{date} 會有人到場", "repairs.rush": "已標記加急",

    "notices.title": "通知", "notices.none": "目前沒有通知。",
    "notices.entry": "進入單位通知",
    "notices.entryBody": "{date}，{from} 至 {to}。原因：{reason}。",
    "notices.entryReschedule": "如果這個時間不方便，回覆我們再另約。",

    "rent.title": "租金", "rent.amount": "每月 {amount}",
    "rent.dueOn": "每月 {day} 號到期", "rent.payLink": "前往繳租",
    "rent.external": "款項由我們的會計系統處理，會將你導向該系統。",
    "rent.breakdown": "每月合計的組成",

    "docs.title": "文件", "docs.none": "目前沒有文件。",
    "docs.lease": "你的租約", "docs.inspection": "入住檢查報告",
    "docs.receipt": "保證金收據", "docs.download": "下載",

    "common.optional": "選填", "common.required": "必填",
    "common.loading": "讀取中…", "common.error": "出了點問題，請再試一次，或直接傳訊息給我們。",
    "common.close": "關閉", "common.yes": "是", "common.no": "否",
    "common.contact": "聯絡我們", "common.privacy": "隱私權",
    "common.office": "辦公室", "common.emergency": "緊急聯絡",
    "footer.legal": "Baydo Development Corporation。面積與格局為約略值，一切以正式租約為準。",
    "footer.fairHousing": "凡符合我們書面條件者皆可承租。我們不會詢問、也不會考量你的家庭狀況、國籍、宗教、年齡或收入來源。",
  },
};

const interpolate = (s, p) => (!p ? s : s.replace(/\{(\w+)\}/g, (m, k) => p[k] ?? m));

export function translate(locale, key, params) {
  const table = D[locale] ?? D.en;
  const val = table[key] ?? D.en[key];
  return val == null ? key : interpolate(val, params);
}

export function detectLocale() {
  try {
    const saved = localStorage.getItem("baydo:tenant-locale");
    if (saved && D[saved]) return saved;
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
  } catch { return "en"; }
}

export function rememberLocale(l) {
  try { localStorage.setItem("baydo:tenant-locale", l); } catch {}
}

export const fmtMoney = (locale, n) =>
  n == null || isNaN(n) ? null
    : new Intl.NumberFormat(locale === "zh" ? "zh-Hant-CA" : "en-CA",
        { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(n);

export const fmtDate = (locale, iso) =>
  !iso ? "" : new Intl.DateTimeFormat(locale === "zh" ? "zh-Hant-CA" : "en-CA",
    { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso));

export default D;
