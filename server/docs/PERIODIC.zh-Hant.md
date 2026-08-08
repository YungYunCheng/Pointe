# 轉按月租約：連帶要改的地方

租約 `end_date` 變成 `NULL` 這一件事，會影響四個地方。**其中三個是靜默失敗。**

---

## 1. 收租排程（最嚴重）

`charge_schedules.end_date` 是**另一個欄位**，跟租約的不是同一個。

只改租約不改排程的話：

```
租約：  end_date  2026-08-31 → NULL          ✓
排程：  end_date  2026-08-31 → 還是 08-31    ✗
```

租金跑批的條件是 `cs.end_date IS NULL OR cs.end_date >= today`，所以 **9 月 1 日之後那一戶就不再開單**。

### 為什麼發現不了

- **欠租報表是乾淨的**——因為根本沒開單，不算欠
- **租客不會抱怨**——他們沒收到帳單
- **月報少一戶**——330 戶裡少 1 戶，看不出來

通常是年底對帳，或租客搬走時對不上，才會浮出來。

**車位、儲藏室、寵物月費也各有自己的排程**，而且更容易漏掉——因為金額小。一個安靜停掉的 $95 車位費，要到年底數字短少才會有人問。

**已修**：`applyRenewal()` 一次改租約和**所有**排程，兩條路徑（免簽直接完成、簽署後完成）共用同一個函式。**兩份複製會走樣，而走樣的那份會是沒人測到的那份。**

---

## 2. 按月租約永遠不會再被掃到

續約掃描找的是 `end_date IS NOT NULL AND end_date <= horizon`。

按月租約沒有到期日，所以**它再也不會出現在任何清單上**。

**這就是一戶住了三年、租金還停在第一年的方式。** 沒有人決定要這樣，只是從來沒有一個時刻把這個問題拋出來。

**已修**：按月租約改用自己的時鐘——**365 天過了、法律上又可以調整時**浮上來。畫面上會顯示「已維持這個租金 N 個月」而不是倒數天數。

通知一個月一次，不是每天。**沒有截止日的東西每天通知，就是人們學會忽略的通知。**

---

## 3. 通知期沒有起算點

固定期是從到期日往回推。**按月沒有到期日**——通知期還是有，但從「實際發出通知的那天」起算。

所以畫面上不顯示「還剩 N 天」，改成「發出通知後 N 天」。**沒有可以遲到的東西。**

---

## 4. 資料庫層的兩道保護

排程靠排程檢查太慢了，所以加在資料庫：

**約束**：`periodic` 必須 `end_date IS NULL`，固定期必須有值。兩者互斥，而設定它們的程式散在不只一個檔案。

**觸發器**：排程的結束日不能早於租約的。存的當下就擋，而不是等每天的檢查。

```
ERROR: This tenancy is periodic and has no end date, so the rent
       schedule cannot end on 2026-08-31 — it would stop billing
       while the tenant is still living there.
```

**檢視 `active_tenancies`**：一個地方定義「什麼在計費、什麼沒有」，儀表板、月結清單和 SQL editor 都用同一份。裡面的 `schedules_stopped` **只要大於零，就是有人住在一間沒在收租的房子裡**。

---

## 5. 每日排程加了一項

`findStoppedSchedules()`——租約還 active 但排程已經過期的，通知會計。

這是**在一週內抓到、而不是年底才抓到**的那道網。

---

## 要跑的 SQL

```bash
psql "$DATABASE_URL" -f worker/schema/007_periodic.sql
```

**如果現有資料裡已經有不一致的**，那個約束會擋住整份。先查：

```sql
SELECT id, unit_number, term_type, end_date FROM leases
WHERE status = 'active'
  AND ((term_type = 'periodic' AND end_date IS NOT NULL)
    OR (term_type <> 'periodic' AND end_date IS NULL));

SELECT cs.unit_number, cs.kind, cs.end_date, l.end_date AS lease_end
FROM charge_schedules cs JOIN leases l ON l.id = cs.lease_id
WHERE cs.is_active AND l.status = 'active'
  AND cs.end_date IS NOT NULL
  AND (l.end_date IS NULL OR cs.end_date < l.end_date);
```

**第二個查詢回傳的每一列，都是一戶正在住、但沒有在收租的房子。**
