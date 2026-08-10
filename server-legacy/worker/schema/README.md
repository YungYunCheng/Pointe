# Schema

跑的順序：

```bash
psql "$DATABASE_URL" -f 001_schema.sql        # 111 張表
psql "$DATABASE_URL" -f 002_seed.sql          # 角色、權限、三棟樓、330 戶
psql "$DATABASE_URL" -f 003_verification.sql  # Email 驗證
psql "$DATABASE_URL" -f 004_prospects.sql     # 訪客帳號
psql "$DATABASE_URL" -f 005_admin.sql         # 第一個 Admin
```

或直接貼進 Supabase 的 SQL Editor，一份一份來。

---

## 第一次登入

```
admin@themizar.ca
Use Forgot password for admin@themizar.ca; no bootstrap password is stored.
```

**這組密碼在檔案裡、在版本庫裡、在對話紀錄裡。當成所有人都知道。**

它標記了 `must_change_password`，所以主控台會先要你換掉。第一次登入就換，這一行就不再重要了。

換完之後到 **Admin → Invite**，把 PM、BM、Accounting 三個人加進去。**他們各自從連結設自己的密碼，沒有人會收到密碼。**

---

## 兩種帳號，兩條路

### 員工：邀請制

```
Admin 建帳號並選角色
  → 帳號是 inactive、沒有密碼雜湊
  → 寄邀請信（72 小時、一次性）
  → 對方開連結、自己設密碼
  → 帳號才能用
```

沒有自助註冊，而且不該有——**這個主控台能過帳到總帳**。

### 租客：先註冊，之後才綁單位

```
任何人都能註冊  →  確認 Email  →  預約看房、送申請
                                        ↓
                              簽約時，由員工把帳號接上單位
                                        ↓
                              才看得到租約、報修、帳務
```

帳號有兩種狀態：

| | 誰能做 | 看得到什麼 |
|---|---|---|
| `prospect` | 自助 | **只有自己送出的東西** |
| `tenant` | **員工連結** | 那一戶的租約、帳務、通知 |

**「接上單位」這一步永遠不是自助的。**

如果誰都能把自己的帳號綁到某個房號，住戶專區就會把別人家的租約給他看，而註冊表單就是入口。簽約的人知道租約簽了，所以由簽約的人來接。

---

## Email 驗證

四種用途，同一張表：

| purpose | 有效期 | 用途 |
|---|---|---|
| `signup` | 48 小時 | 確認訪客的 Email |
| `tenant_claim` | 48 小時 | 忘記密碼重設 |
| `staff_invite` | 72 小時 | 員工設定密碼 |
| `email_change` | — | 之後會用到 |

**Token 一律雜湊後儲存。** 不然那張表就是一份可用憑證清單，備份外洩等於所有待認領帳號都被拿走。

**一次性，而且認領時 `FOR UPDATE` 鎖住**——信件連結真的會被雙擊，沒鎖的話第二次不是報錯就是建出重複帳號。

---

## 密碼雜湊

PBKDF2-SHA512，600,000 輪。演算法跟著雜湊一起存，所以以後換演算法不用叫所有人重設。

**Argon2id 更好，但在 Workers 上跑不了**——它是原生模組，沒有 flag 可以開。這是真的取捨不是等價替換：對持有 GPU 的攻擊者，PBKDF2 比較弱。選它是因為這裡的另一個選項是純 JS 的 scrypt，對使用者更慢而且沒有比較強。
