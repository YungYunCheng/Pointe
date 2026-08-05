import { db, uid } from "./db.js";

/* ============================================================
   The agreements an Alberta rental needs.

   Seeded empty on purpose. Each one is a slot waiting for the file
   a lawyer approved — the system never fills them in, and an empty
   library is meant to look empty so that nobody discovers it on the
   day they need a lease.
   ============================================================ */

const AGREEMENTS = [
  ["lease", "Residential Tenancy Agreement", "住宅租約", 10,
   "The main lease. Nothing downstream can complete without an approved version of this.",
   ["always"]],

  ["parking", "Parking Agreement", "車位使用協議", 20,
   "Kept separate from the lease so a stall can be given up or reassigned without reopening the tenancy.",
   ["parking"]],

  ["storage", "Storage Locker Agreement", "儲藏室協議", 30,
   null, ["storage"]],

  ["pet", "Pet Addendum", "寵物附約", 40,
   "Service animals are not pets. This does not apply to them and must not be sent to a tenant who has one.",
   ["pets"]],

  ["inspection_in", "Move-in Inspection Report", "入住檢查報告", 50,
   "Required in Alberta, completed at move-in. Without it a deposit dispute is very hard to defend.",
   ["always"]],

  ["inspection_out", "Move-out Inspection Report", "遷出檢查報告", 60,
   "Required in Alberta, completed at move-out.", ["moveout"]],

  ["deposit_receipt", "Security Deposit Receipt", "保證金收據", 70,
   "The deposit is held in trust; the receipt states where.", ["always"]],

  ["keys", "Key and Fob Acknowledgement", "鑰匙與門禁卡簽收單", 80,
   null, ["always"]],

  ["renewal", "Renewal Notice", "續約通知", 90, null, ["renewal"]],

  ["termination", "Notice of Termination", "終止通知", 100,
   "Notice periods come from the RTA. Have this one checked carefully before it is used.",
   ["termination"]],

  ["emergency_contact", "Emergency Contact Form", "緊急聯絡資料表", 110, null, ["always"]],
];

export function seedAgreements() {
  const ins = db.prepare(`INSERT OR IGNORE INTO agreements (id, code, name_en, name_zh,
    description, required_for, sort_order) VALUES (?,?,?,?,?,?,?)`);
  for (const [code, en, zh, order, desc, required] of AGREEMENTS)
    ins.run(uid("ag_"), code, en, zh, desc, JSON.stringify(required), order);

  const n = db.prepare("SELECT COUNT(*) n FROM agreements").get().n;
  const live = db.prepare(`SELECT COUNT(*) n FROM agreement_versions
    WHERE state='approved'`).get().n;
  console.log(`[seed] agreements: ${n} slots, ${live} with an approved file`);
  if (live === 0)
    console.log("[seed] no agreements uploaded yet — nothing can be signed until Admin adds the lease");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedAgreements();
}
