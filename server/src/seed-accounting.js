import { db, uid, hashPassword } from "./db.js";

/* ============================================================
   Chart of accounts for a residential rental in Alberta.

   The one that matters: 1020 and 2100. A security deposit is the
   tenant's money. It sits in a separate trust bank account and shows
   as a liability, because we owe it back. Booking a deposit to
   revenue makes the year look good and leaves nothing to refund.

   Codes follow the usual blocks so anyone who has seen a set of
   books before can find their way: 1000 assets, 2000 liabilities,
   3000 equity, 4000 revenue, 5000 expenses.
   ============================================================ */

// code, en, zh, type, parent, side, postable, trust, bank
const COA = [
  ["1000", "Assets", "資產", "asset", null, "debit", 0, 0, 0],
  ["1010", "Operating bank account", "營運銀行帳戶", "asset", "1000", "debit", 1, 0, 1],
  ["1020", "Trust account — security deposits", "信託帳戶 — 保證金", "asset", "1000", "debit", 1, 1, 1],
  ["1100", "Accounts receivable — tenants", "應收帳款 — 租客", "asset", "1000", "debit", 1, 0, 0],
  ["1110", "Allowance for doubtful accounts", "備抵呆帳", "asset", "1000", "credit", 1, 0, 0],
  ["1200", "Prepaid expenses", "預付費用", "asset", "1000", "debit", 1, 0, 0],
  ["1210", "GST receivable", "應收 GST", "asset", "1000", "debit", 1, 0, 0],
  ["1500", "Buildings", "建築物", "asset", "1000", "debit", 1, 0, 0],
  ["1510", "Accumulated depreciation", "累計折舊", "asset", "1000", "credit", 1, 0, 0],

  ["2000", "Liabilities", "負債", "liability", null, "credit", 0, 0, 0],
  ["2010", "Accounts payable — vendors", "應付帳款 — 廠商", "liability", "2000", "credit", 1, 0, 0],
  ["2100", "Security deposits held", "代收保證金", "liability", "2000", "credit", 1, 1, 0],
  ["2110", "Deposit interest payable", "應付保證金利息", "liability", "2000", "credit", 1, 1, 0],
  ["2200", "Prepaid rent", "預收租金", "liability", "2000", "credit", 1, 0, 0],
  ["2300", "GST payable", "應付 GST", "liability", "2000", "credit", 1, 0, 0],
  ["2400", "Accrued liabilities", "應計負債", "liability", "2000", "credit", 1, 0, 0],

  ["3000", "Equity", "權益", "equity", null, "credit", 0, 0, 0],
  ["3010", "Owner capital", "業主資本", "equity", "3000", "credit", 1, 0, 0],
  ["3020", "Owner draws", "業主提取", "equity", "3000", "debit", 1, 0, 0],
  ["3900", "Retained earnings", "保留盈餘", "equity", "3000", "credit", 1, 0, 0],

  ["4000", "Revenue", "收入", "revenue", null, "credit", 0, 0, 0],
  ["4010", "Rental income", "租金收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4020", "Parking income", "車位收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4030", "Storage income", "儲藏室收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4040", "Pet rent", "寵物月費收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4050", "Application fees", "申請費收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4060", "Late fees", "逾期費收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4070", "Damage recovery", "損壞賠償收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4080", "Laundry and vending", "洗衣與販賣機收入", "revenue", "4000", "credit", 1, 0, 0],
  ["4090", "Other income", "其他收入", "revenue", "4000", "credit", 1, 0, 0],

  ["5000", "Operating expenses", "營運費用", "expense", null, "debit", 0, 0, 0],
  ["5010", "Repairs and maintenance", "維修保養", "expense", "5000", "debit", 1, 0, 0],
  ["5020", "Utilities — electricity", "水電 — 電費", "expense", "5000", "debit", 1, 0, 0],
  ["5021", "Utilities — gas and heat", "水電 — 瓦斯與暖氣", "expense", "5000", "debit", 1, 0, 0],
  ["5022", "Utilities — water and sewer", "水電 — 水費與污水", "expense", "5000", "debit", 1, 0, 0],
  ["5030", "Property management", "物業管理費", "expense", "5000", "debit", 1, 0, 0],
  ["5040", "Insurance", "保險", "expense", "5000", "debit", 1, 0, 0],
  ["5050", "Property taxes", "房產稅", "expense", "5000", "debit", 1, 0, 0],
  ["5060", "Cleaning and turnover", "清潔與整備", "expense", "5000", "debit", 1, 0, 0],
  ["5070", "Landscaping and snow removal", "景觀與剷雪", "expense", "5000", "debit", 1, 0, 0],
  ["5080", "Advertising and leasing", "廣告與招租", "expense", "5000", "debit", 1, 0, 0],
  ["5090", "Professional fees", "專業服務費", "expense", "5000", "debit", 1, 0, 0],
  ["5100", "Deposit interest expense", "保證金利息費用", "expense", "5000", "debit", 1, 0, 0],
  ["5110", "Bad debt", "呆帳", "expense", "5000", "debit", 1, 0, 0],
  ["5120", "Bank charges", "銀行手續費", "expense", "5000", "debit", 1, 0, 0],
  ["5130", "Security and access", "保全與門禁", "expense", "5000", "debit", 1, 0, 0],
  ["5140", "Elevator maintenance", "電梯保養", "expense", "5000", "debit", 1, 0, 0],
  ["5150", "Waste removal", "廢棄物清運", "expense", "5000", "debit", 1, 0, 0],
  ["5160", "Pest control", "蟲害防治", "expense", "5000", "debit", 1, 0, 0],
  ["5900", "Other operating expenses", "其他營運費用", "expense", "5000", "debit", 1, 0, 0],
];

const ACCOUNTING_USER = {
  email: "invoice@themizar.ca",
  name: "Accounting",
  role: "accounting",
  password: "Invoice@2026!",
};

export async function seedAccounting() {
  const ins = db.prepare(`INSERT OR IGNORE INTO gl_accounts
    (code, name_en, name_zh, type, parent_code, normal_side, is_postable, is_trust, is_bank)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const a of COA) ins.run(...a);

  db.prepare(`UPDATE gl_accounts SET note = ?
    WHERE code = '2100'`).run(
    "Tenant money held in trust under the Alberta RTA. Never revenue. Must agree with 1020 at all times.");
  db.prepare(`UPDATE gl_accounts SET note = ?
    WHERE code = '1020'`).run(
    "Separate bank account. Operating expenses must never be paid from here.");

  // A placeholder rate so interest accrual can run. Replace with the published
  // figure for the year before relying on it.
  db.prepare(`INSERT OR IGNORE INTO deposit_interest_rates (year, rate, source)
    VALUES (?, ?, ?)`).run(new Date().getFullYear(), 0.0,
    "Placeholder. Set the published rate before accruing.");

  if (!db.prepare("SELECT 1 FROM users WHERE email = ?").get(ACCOUNTING_USER.email)) {
    const h = await hashPassword(ACCOUNTING_USER.password);
    db.prepare(`INSERT INTO users (id, email, full_name, role_code, locale,
      password_algo, password_salt, password_hash) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid("usr_"), ACCOUNTING_USER.email, ACCOUNTING_USER.name, ACCOUNTING_USER.role,
           "en", h.algo, h.salt, h.hash);
    console.log(`[seed] created account ${ACCOUNTING_USER.email} (accounting)`);
  }

  const n = db.prepare("SELECT COUNT(*) n FROM gl_accounts").get().n;
  console.log(`[seed] chart of accounts: ${n} accounts`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedAccounting();
  console.log("[seed] accounting done");
}
