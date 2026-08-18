# 灌進 Supabase

## 一份就好

`baydo_pointe_supabase_complete.sql` — 貼進 SQL Editor，跑一次。

**整份包在一個交易裡**，任何一步失敗會全部回滾。不會留下一半的 schema 要收拾，修好之後直接重跑就行。

180 KB，瀏覽器貼上會慢個幾秒。太慢的話用分段版：`part1_tables` → `part2_features` → `part3_security`，按順序跑。

跑完最後會出來一張表：

```
tables  units  buildings  users  permissions  gl_accounts  payment_methods
   123    330          3      1           41           68               6
```

**`units` 要是 330。** 其他數字對不上就是 seed 沒跑完——「連上了」跟「連到對的資料庫」看起來一模一樣，直到有人要簽約。

---

## Row Level Security：不要跳過這段

**Supabase 把 public schema 裡的每一張表都透過 PostgREST 暴露出去，用 anon key 就能存取。**

那個 key 不是機密——它會出現在任何 Supabase 應用的前端，本來就是設計成公開的，**因為 RLS 才是那道門**。

RLS 沒開的話，**任何拿到專案網址和那個 key 的人，可以讀這裡每一張表的每一列**：租約、聯絡人、總帳、稽核紀錄、密碼雜湊。

這套系統**完全不用 PostgREST**，它走 Hyperdrive 用 postgres 角色連，而那個角色本來就繞過 RLS。所以**開啟 RLS 但不加任何 policy，成本是零，門是全關的**：程式照跑，PostgREST 什麼都拿不到。

檔案最後那段會把每一張表都開起來，包括 `FORCE`——**沒有 FORCE 的話，擁有者角色照樣讀得到全部**，而設定出錯的客戶端最容易變成的就是擁有者角色。

以後如果真的有東西要用 anon key，**只針對那幾張表加 policy**。不要加全域 policy，也不要把這個關掉。

---

## 連線字串

Supabase 專案 → Connect → 選 **Session pooler** 或 **Direct connection**。

```powershell
npx wrangler hyperdrive create pointe-db --connection-string="postgresql://postgres:[密碼]@db.ulcsulnftdsqaqxbjkzc.supabase.co:5432/postgres"
```

把回傳的 id 填進 `worker/wrangler.jsonc`，然後打 `/api/db-health`。

**Hyperdrive 不是可選的。** Worker 沒有常駐行程放連線池，沒有它每個請求都開一條新連線——`t3.nano` 只有 60 條，330 戶的流量會很快用完。

---

## 跑完之後

如果是从旧版本升级，不要重跑完整 schema。请在 Supabase SQL Editor 单独
执行 `019_workers_ai_cloud.sql`。它会建立公开聊天纪录和每日 AI 用量表，
现有资料不会被删除。

**1. 在登入頁為 `admin@themizar.ca` 使用 Forgot password。**

Schema 不含初始密碼；由一次性郵件連結設定第一組密碼。

**2. Admin → Invite，把 PM、BM、Accounting 加進去。** 他們各自從連結設密碼，沒有人會收到密碼。

**3. 確認 `worker/src/lib/rules.js` 裡的法律數字。**

365 天、90 天通知、各送達方式的視為收到天數——**這些決定一份通知有沒有效，而弄錯是讓通知作廢不是縮短**。

---

## 一件關於位置的事

專案在 `ca-central-1`，資料留在加拿大。**對 PIPA 是對的選擇**——租客資料跨境會需要在隱私政策裡揭露，而現在不用。

隱私政策裡已經寫了 AI 服務商可能在境外處理訊息，那個仍然成立。但**資料庫本身在境內**，這是兩件事。
