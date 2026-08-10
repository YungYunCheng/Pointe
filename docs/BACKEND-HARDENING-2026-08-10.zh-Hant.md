# 後端補強與缺口報告（2026-08-10）

## 結論

正式的 `worker/` 原本只有健康檢查骨架；這次已把可用的 Cloudflare Worker
路由移入正式目錄，修正阻斷執行的 SQL／JavaScript 問題，並完成最重要的
帳號、租約、租金調整、付款與租客自助流程。

目前可以作為「核心租務 API 的 staging 版本」，但還不能把整套員工後台
宣稱為完整上線：CRM、完整會計、文件／電子簽署、後台維修流程與 AI 路由
仍待從 `server-legacy/` 逐一移植。

## 已完成

### 身分驗證與權限

- 員工與租客使用不同的 HttpOnly session cookie；瀏覽器不再保存 bearer token。
- Cookie 使用 `SameSite=Strict`，production 加 `Secure`，路徑限制為 `/api`。
- 私有路由預設拒絕，`/api/public/*` 才公開；租客與員工 token 不互通。
- 後端強制密碼到期／首次變更，新增已知密碼變更端點與密碼歷史。
- 登入失敗次數改成 SQL 原子遞增；重設 token 改成交易內一次性領取，避免重播競態。
- 忘記密碼不洩漏帳號是否存在，並使舊 token／其他 session 失效。
- 移除版本庫中的初始管理員密碼。`admin@themizar.ca` 必須用 Forgot password 設定第一組密碼。
- 所有 API 加上基本安全 header、1 MiB request 上限、cookie 寫入的 Origin allowlist。

### 租務規則

- 租金調整至少相隔 365 天，fixed term 不允許期中調租。
- 月租調租日改以「3 個完整 tenancy months」計算，不再誤用 90 個日曆日。
- fixed term 自動到期不再錯套 60 天通知；periodic tenancy 保留對應規則。
- 電子送達租金調整通知前，必須先在 contact 明確登記可用的 electronic address for service。
- 新增登記／撤銷 electronic address for service 的員工端點與 audit。
- 租期型別統一為 `fixed`、`fixed_6`、`fixed_12`、`periodic`。
- 保證金與寵物保證金在伺服器端遵守「合計不超過一個月租金」的上限，前端金額不受信任。

正式規則仍應由 Alberta 租務律師在正式送件前覆核。

### 租客自助

- `/api/public/availability`：空房、目前租金、費用、停車位摘要。
- 補齊 `/signup`、`/verify`、`/claim`、`/reset` 頁面；後端寄出的連結現在都有可完成的前端流程。
- 初次 tenant claim 與 password reset 使用不同 token purpose，避免 claim token 被錯誤端點消耗。
- `/api/public/slots`：以 Edmonton 時區、假日、辦公時間、已佔用時段及 24 小時進入通知限制產生看房時段。
- `POST /api/tenant/viewings`：登入且已驗證 Email 才能預約；伺服器身分、交易鎖與重複請求鍵避免冒名及重複佔位。
- `POST /api/tenant/applications`：從登入帳號取得 Email；租金、停車、儲藏、寵物與 upfront total 全由資料庫現行價目重算。
- 租客可以查看自己的預約與申請，已修正原本查詢不存在欄位而產生 500 的問題。
- 維修回報、維修狀態、進入通知、應收帳與 statement download 已接 API，不再只存在瀏覽器。
- prospect 與 tenant 的 portal 顯示分開；prospect 不會看到空白的租金／維修頁。
- 文件上傳尚未完成，因此申請頁不再假裝已上傳檔案，改為後補文件。

### 資料庫與可靠性

- 新增 `011_security_hardening.sql`，包含送達地址、租期 constraint、session／token index、密碼歷史參數、停車 contact 與防重複 request id。
- 修正 notification 欄位名稱、pricing profile 必填名稱、cat/dog deposit、parking contact 等程式／schema 不一致。
- SQL 檢查器現在也會驗 Worker 路由內的 `INSERT` 欄位，不只驗 migration 本身。
- 同一看房時段使用 Postgres transaction advisory lock，避免兩個請求同時拿到最後時段。
- Cron 與每個 request 都會釋放 Postgres 連線。

## 尚未完成（不可誤認為已上線）

### P0：正式上線前

1. **Staging 資料庫整合測試**：本次環境沒有實際 Supabase／Hyperdrive，尚未跑真實 migration 與端到端交易測試。
2. **Cloudflare 設定**：`worker/wrangler.jsonc` 的 domain、Hyperdrive ID、KV ID 仍是 placeholder。
3. **寄信**：必須設定 Resend 金鑰、寄件網域與 outbox cron，否則邀請、Email 驗證、重設密碼與法定通知不會送達。
4. **文件與電子簽署**：R2 上傳、核准版本、簽署 ceremony、完成證明與租客下載尚未移植。
5. **後台維修／進入通知**：租客可報修與查看，但員工的派工、排程、完成、照片證據與正式送達流程仍缺 Worker 路由。
6. **完整會計**：已有付款、AR 套用、撤銷、租客付款方法等核心路由，但 GL、AP、銀行對帳、period close、報表與 amendment 尚未移植。外部 payment processor 未接好前不可開放真正付款按鈕。

### P1：核心租務後

- Leads／CRM、showing outcome、完整 schedule CRUD。
- Agreement library、document template／approval、key handover、move-out、deposit deduction evidence。
- Admin user list／permission override、audit export、retention／backup restore。
- AI inbox、lease intake、public chat 的伺服器路由與硬性規則閘門。
- Notifications／outbox 的員工 UI、重試／dead-letter 管理與監控告警。
- 租客 contact preferences 與實際 legal-service channel 的後端保存。
- 租客文件上傳（R2、MIME／大小驗證、malware scanning、下載授權）。

## 部署順序

### 新資料庫

執行 `worker/schema/baydo_pointe_supabase_complete.sql`。

### 已有 001–010 的資料庫

只執行：

```bash
psql "$DATABASE_URL" -f worker/schema/011_security_hardening.sql
```

接著設定 Cloudflare domain、Hyperdrive、KV、R2 與 secrets，再在 staging 依序測試：

1. Admin Forgot password／登入／換密碼。
2. 邀請員工與權限拒絕。
3. Prospect 註冊、驗證、登入、預約、申請及重送同一 request id。
4. Staff link account 到 lease，確認租客只能看到自己的 unit。
5. 月租與 fixed-term 的租金調整 eligibility／serve／withdraw。
6. 付款、撤銷、租客 statement，確認每筆 journal 平衡。
7. outbox 寄送、失敗重試與 audit log。

## 已執行的驗證

- 全部 Worker JavaScript：`node --check` 通過。
- Worker 靜態檢查：`npm run check` 通過。
- 123 張資料表與 Worker route INSERT 欄位：`npm run check:sql` 通過。
- Staff Vite production build 通過。
- Tenant Vite production build 通過。
- Worker 直接 smoke test：health 200、無 session 私有路由 401、跨站 POST 403，安全 header 存在。
- 已掃描並移除已知 prototype／seed 密碼。
