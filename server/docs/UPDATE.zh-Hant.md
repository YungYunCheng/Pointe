# 這次要換哪些

## 換三個檔案

```
worker/schema/001_schema.sql
worker/schema/009_contract_dates.sql
worker/schema/baydo_pointe_supabase_complete.sql
worker/scripts/check-sql.mjs
```

其他**一個都不用動**。

---

## 程式碼完全沒動，而且這件事值得說清楚

修的全是 schema 的型別。**程式碼一直是對的**：

| 欄位 | 程式一直怎麼用 | schema 原本錯在 |
|---|---|---|
| `deposit_to`、`paid_from` | 寫 `'1010'` 這種 GL 代碼 | 被誤轉成 `DATE` |
| `assigned_to` | 寫 `usr_xxx` | 被誤轉成 `DATE` |
| `applied_to` | 寫 JSON 陣列 | 被誤轉成 `DATE` |
| `last_increase_at` | 一直當日期用 | 宣告成 `TIMESTAMPTZ` |
| `is_active` | 寫 `TRUE`、查 `WHERE is_active` | 部分索引還在比 `= 1` |
| `password_hash` | 未認領帳號不給值 | `NOT NULL` 擋住 |

**是 schema 跟程式不一致，不是程式有 bug。** 所以換 schema 就好。

---

## 六個修正，四個是跑不完的

**1. `password_salt` / `password_hash` 改成可空**

seed 建四個帳號時刻意不給密碼——**沒有雜湊的帳號登不進去，那是沒人認領的帳號該有的狀態**。但 `NOT NULL` 讓那個 INSERT 直接失敗。

**2. `deposit_to`、`paid_from`、`assigned_to`、`applied_to` 改回 `TEXT`**

我早先的日期正則把所有 `_to` / `_from` 結尾的欄位轉成 `DATE`。**那些存的是科目代碼、user id 和 JSON。**

**3. `audit_id` 改成 `BIGINT`**

`audit_log.id` 是 `BIGINT`，外鍵型別要一致。

**4. 部分索引的 `WHERE is_active = 1` 改成 `= TRUE`**

欄位已經是 `BOOLEAN`，條件還在比整數。

**5. `CURRENT_TIMESTAMP::text` → `CURRENT_TIMESTAMP`（90 處）**

**這個不會報錯，所以最危險。**

轉成字串再轉回 `TIMESTAMPTZ` 會丟掉時區。Alberta 夏令時是 UTC-6，所以**每一筆 `created_at` 會差 6 小時**——而且方向一致，看起來完全正常。

**6. `last_increase_at` 在 001 直接宣告成 `DATE`**

原本是先建 `TIMESTAMPTZ`，再在 009 用 `ALTER` 轉。**同一份檔案裡建完又改，讀的人會不確定它到底是什麼。**

---

## 灌資料庫的順序

```
1. 00_reset_first.sql                      清掉半殘的表和擴充
2. baydo_pointe_supabase_complete.sql      主檔
```

**第一步不能省。** 之前那幾次失敗留下了表，而 `CREATE TABLE IF NOT EXISTS` 遇到已存在的表就跳過——修好的型別永遠套不進去。

也留下了擴充的註冊列：`DROP SCHEMA public CASCADE` 會刪掉裝在 public 的擴充，但 `pg_extension` 那一列還在，於是 `CREATE EXTENSION IF NOT EXISTS` 什麼都不做而型別已經沒了。

跑完應該看到 `units = 330`。
