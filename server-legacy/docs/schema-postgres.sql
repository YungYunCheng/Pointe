-- ============================================================
-- Baydo Pointe 租賃管理系統 — PostgreSQL Schema
-- 對應 baydo-erd.mermaid
-- 版本 v1.0 / 2026-07-31
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ════════════════════════════════════════════════════════════
-- 1. 身分與權限
-- ════════════════════════════════════════════════════════════

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,          -- admin | agent
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,          -- pricing.edit, parking.quota.edit, template.approve ...
    description text
);

CREATE TABLE role_permissions (
    role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 citext NOT NULL UNIQUE,
    full_name             text NOT NULL,
    phone                 text,
    role_id               uuid NOT NULL REFERENCES roles(id),
    -- 密碼永不存明文。上線請用 argon2id；PBKDF2 僅為原型過渡。
    password_algo         text NOT NULL DEFAULT 'argon2id',
    password_salt         text NOT NULL,
    password_hash         text NOT NULL,
    password_iterations   integer,
    must_change_password  boolean NOT NULL DEFAULT true,
    is_active             boolean NOT NULL DEFAULT true,
    failed_attempts       integer NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    last_login_at         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role_id) WHERE is_active;

CREATE TABLE sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,          -- 只存雜湊，原始 token 只給客戶端
    expires_at  timestamptz NOT NULL,
    ip          inet,
    user_agent  text,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    requested_ip inet,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_prt_user ON password_reset_tokens(user_id) WHERE used_at IS NULL;

CREATE TABLE audit_log (
    id            bigserial PRIMARY KEY,
    actor_user_id uuid REFERENCES users(id),
    action        text NOT NULL,
    entity_type   text NOT NULL,
    entity_id     uuid,
    before_value  jsonb,
    after_value   jsonb,
    ip            inet,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);

-- ════════════════════════════════════════════════════════════
-- 2. 物業
-- ════════════════════════════════════════════════════════════

CREATE TABLE buildings (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code       text NOT NULL UNIQUE,           -- 370 / 374 / 378
    name       text NOT NULL,
    address    text NOT NULL,
    storeys    integer NOT NULL,
    unit_count integer NOT NULL,
    floor_area_sqm numeric(10,2),
    accent_color   text
);

CREATE TABLE unit_types (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE,        -- 1A / 1A (M) / 2A / 3A ...
    bedroom_label text NOT NULL,               -- 1房 / 2房2衛 / 2房+書房
    bedrooms      integer NOT NULL,
    area_sqft     numeric(8,2) NOT NULL,
    area_sqm      numeric(8,2),
    balcony_sqft  numeric(8,2),
    patio_sqft    numeric(8,2),
    is_mirrored   boolean NOT NULL DEFAULT false
);

CREATE TABLE units (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id    uuid NOT NULL REFERENCES buildings(id),
    unit_type_id   uuid NOT NULL REFERENCES unit_types(id),
    unit_number    text NOT NULL UNIQUE,       -- 378-519
    floor          integer NOT NULL,
    status         text NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available','held','leased','offline')),
    available_from date,
    rent_override  numeric(10,2),
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_units_status ON units(status, building_id);
CREATE INDEX idx_units_type ON units(unit_type_id);

CREATE TABLE amenities (
    id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name  text NOT NULL UNIQUE
);
CREATE TABLE building_amenities (
    building_id uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    amenity_id  uuid NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
    PRIMARY KEY (building_id, amenity_id)
);

-- ════════════════════════════════════════════════════════════
-- 3. 定價（版本化：改價不覆蓋歷史，才追得回當時報的價）
-- ════════════════════════════════════════════════════════════

CREATE TABLE pricing_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL,
    effective_from date NOT NULL,
    effective_to   date,
    created_by     uuid NOT NULL REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE unit_type_rents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pricing_profile_id uuid NOT NULL REFERENCES pricing_profiles(id) ON DELETE CASCADE,
    unit_type_id       uuid NOT NULL REFERENCES unit_types(id),
    base_rent          numeric(10,2) NOT NULL CHECK (base_rent >= 0),
    UNIQUE (pricing_profile_id, unit_type_id)
);

CREATE TABLE fee_settings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pricing_profile_id  uuid NOT NULL UNIQUE REFERENCES pricing_profiles(id) ON DELETE CASCADE,
    deposit_mode        text NOT NULL DEFAULT 'one_month'
                        CHECK (deposit_mode IN ('one_month','fixed')),
    deposit_fixed       numeric(10,2),
    cat_deposit         numeric(10,2) DEFAULT 0,
    dog_deposit         numeric(10,2) DEFAULT 0,
    pet_rent            numeric(10,2) DEFAULT 0,
    pet_limit           text,
    parking_underground numeric(10,2),
    parking_surface     numeric(10,2),
    storage_fee         numeric(10,2),
    application_fee     numeric(10,2),
    utilities_included  text
);
-- 注意：Alberta 保證金上限為一個月租金，寵物押金須計入該上限。
-- 此規則跨表，於應用層或觸發器強制，勿只靠前端。

-- ════════════════════════════════════════════════════════════
-- 4. 車位與儲藏室
-- ════════════════════════════════════════════════════════════

CREATE TABLE parking_pools (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id       uuid REFERENCES buildings(id),
    code              text NOT NULL UNIQUE,    -- u370 / u374 / u378 / surface
    label             text NOT NULL,
    total_stalls      integer NOT NULL CHECK (total_stalls >= 0),
    tandem_stalls     integer NOT NULL DEFAULT 0,
    accessible_stalls integer NOT NULL DEFAULT 0,
    is_surface        boolean NOT NULL DEFAULT false,
    note              text
);

CREATE TABLE parking_allocations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id      uuid NOT NULL REFERENCES parking_pools(id),
    unit_id      uuid NOT NULL REFERENCES units(id),
    lease_id     uuid,                          -- FK 於 leases 建立後補
    status       text NOT NULL CHECK (status IN ('assigned','waiting','released')),
    requested_at timestamptz NOT NULL DEFAULT now(),   -- 先到先得的唯一排序依據
    assigned_at  timestamptz,
    released_at  timestamptz,
    created_by   uuid REFERENCES users(id),
    CHECK (status <> 'assigned' OR assigned_at IS NOT NULL)
);
CREATE INDEX idx_parking_queue ON parking_allocations(pool_id, status, requested_at);
CREATE INDEX idx_parking_unit ON parking_allocations(unit_id) WHERE status <> 'released';

-- 配位不得超過配額：寫入時需取 pool 層級的鎖再檢查，不可只靠應用層判斷。
--   BEGIN;
--   SELECT total_stalls FROM parking_pools WHERE id = $1 FOR UPDATE;
--   SELECT count(*) FROM parking_allocations WHERE pool_id = $1 AND status='assigned';
--   INSERT ...;
--   COMMIT;

CREATE TABLE storage_lockers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id uuid NOT NULL REFERENCES buildings(id),
    unit_id     uuid REFERENCES units(id),
    code        text NOT NULL,
    status      text NOT NULL DEFAULT 'available',
    UNIQUE (building_id, code)
);

-- ════════════════════════════════════════════════════════════
-- 5. 客戶、訊息與 AI 路由
-- ════════════════════════════════════════════════════════════

CREATE TABLE contacts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name           text,
    email               citext,
    phone               text,
    locale              text DEFAULT 'en',
    consent_basis       text,                  -- implied_inquiry / express / transactional
    consent_expires_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_phone ON contacts(phone);

CREATE TABLE threads (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id          uuid NOT NULL REFERENCES contacts(id),
    channel             text NOT NULL CHECK (channel IN ('email','webform','sms','whatsapp')),
    state               text NOT NULL DEFAULT 'open',
    assigned_to_user_id uuid REFERENCES users(id),
    unit_interest_id    uuid REFERENCES units(id),
    last_message_at     timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id   uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    direction   text NOT NULL CHECK (direction IN ('inbound','outbound')),
    body        text NOT NULL,
    meta        jsonb,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_thread ON messages(thread_id, received_at);

CREATE TABLE intents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code             text NOT NULL UNIQUE,
    label            text NOT NULL,
    automation_level text NOT NULL CHECK (automation_level IN ('L0','L1','L2','L3'))
);

CREATE TABLE routing_rules (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text NOT NULL,              -- R-2041 / R-101
    version        text NOT NULL,
    condition      jsonb NOT NULL,
    action         text NOT NULL,
    effective_from date NOT NULL,
    approved_by    uuid REFERENCES users(id),
    approved_at    timestamptz,
    UNIQUE (code, version)
);

CREATE TABLE message_classifications (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id     uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    intent_id      uuid REFERENCES intents(id),
    confidence     numeric(4,3),
    model          text,
    prompt_version text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    body       text NOT NULL,
    facts_used jsonb,                          -- 事實快照：日後可證明當時報的價
    status     text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbound_log (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id         uuid REFERENCES drafts(id),
    thread_id        uuid NOT NULL REFERENCES threads(id),
    rule_id          uuid REFERENCES routing_rules(id),
    routing_decision text NOT NULL,
    edited_by_human  boolean NOT NULL DEFAULT false,
    sent_by_user_id  uuid REFERENCES users(id),
    sent_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocked_events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    rule_id    uuid NOT NULL REFERENCES routing_rules(id),
    blocked_at timestamptz NOT NULL DEFAULT now(),
    note       text
    -- 刻意不儲存訊息中涉及受保護特徵的原文，只留規則編號
);

-- ════════════════════════════════════════════════════════════
-- 6. 排程、任務與提醒
-- ════════════════════════════════════════════════════════════

CREATE TABLE holidays (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    holiday_date date NOT NULL UNIQUE,
    name         text NOT NULL,
    is_observed  boolean NOT NULL DEFAULT true  -- Heritage Day 等選擇性假日設 false
);

CREATE TABLE slots (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id),
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('showing','signing')),
    state      text NOT NULL DEFAULT 'open',
    CHECK (ends_at > starts_at)
);
-- 防重複預約：同一專員時段不得重疊
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE slots ADD CONSTRAINT slots_no_overlap
    EXCLUDE USING gist (user_id WITH =, tstzrange(starts_at, ends_at) WITH &&);

CREATE TABLE events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type         text NOT NULL CHECK (type IN ('showing','signing','followup','review')),
    unit_id      uuid REFERENCES units(id),
    contact_id   uuid REFERENCES contacts(id),
    slot_id      uuid UNIQUE REFERENCES slots(id),
    starts_at    timestamptz NOT NULL,
    duration_min integer NOT NULL DEFAULT 30,
    state        text NOT NULL DEFAULT 'booked'
                 CHECK (state IN ('booked','done','cancelled','no_show')),
    created_via  text NOT NULL DEFAULT 'staff' CHECK (created_via IN ('ai_auto','staff','tenant')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_day ON events(starts_at) WHERE state = 'booked';

CREATE TABLE tasks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type          text NOT NULL,
    title         text NOT NULL,
    event_id      uuid REFERENCES events(id) ON DELETE CASCADE,
    unit_id       uuid REFERENCES units(id),
    contact_id    uuid REFERENCES contacts(id),
    owner_user_id uuid REFERENCES users(id),
    scheduled_at  timestamptz NOT NULL,
    state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','cancelled')),
    source_ref    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_day ON tasks(owner_user_id, scheduled_at) WHERE state = 'open';

CREATE TABLE reminders (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    audience text NOT NULL CHECK (audience IN ('tenant','staff')),
    send_on  date NOT NULL,                    -- 事件日的前一個工作日
    sent_at  timestamptz,
    channel  text,
    UNIQUE (event_id, audience)
);
CREATE INDEX idx_reminders_due ON reminders(send_on) WHERE sent_at IS NULL;

-- 前一個工作日（週一 → 週五；遇假日再往前推）
CREATE OR REPLACE FUNCTION prev_business_day(d date) RETURNS date AS $$
DECLARE r date := d - 1;
BEGIN
    WHILE EXTRACT(ISODOW FROM r) > 5
       OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = r AND h.is_observed)
    LOOP
        r := r - 1;
    END LOOP;
    RETURN r;
END;
$$ LANGUAGE plpgsql STABLE;

-- ════════════════════════════════════════════════════════════
-- 7. 文件範本與簽署
-- ════════════════════════════════════════════════════════════

CREATE TABLE document_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    kind        text NOT NULL CHECK (kind IN
                ('lease','parking','storage','pet','inspection','notice','receipt','other')),
    status      text NOT NULL DEFAULT 'missing'
                CHECK (status IN ('missing','draft','approved','retired')),
    version     text,
    storage_uri text,
    approved_by uuid REFERENCES users(id),
    approved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- 只有 status='approved' 的範本可產生 document_instances，於應用層強制。

CREATE TABLE template_fields (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    field_key   text NOT NULL,
    label       text,
    source      text NOT NULL CHECK (source IN ('backend','tenant','staff')),
    data_type   text NOT NULL DEFAULT 'text',
    options     jsonb,
    is_required boolean NOT NULL DEFAULT true,
    note        text,
    UNIQUE (template_id, field_key)
);

CREATE TABLE leases (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id            uuid NOT NULL REFERENCES units(id),
    start_date         date NOT NULL,
    end_date           date,
    term_type          text NOT NULL CHECK (term_type IN ('fixed_12','fixed_6','periodic')),
    rent               numeric(10,2) NOT NULL,
    deposit            numeric(10,2) NOT NULL,
    occupants          integer,
    status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','ended','terminated')),
    pricing_profile_id uuid REFERENCES pricing_profiles(id),
    created_by         uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (end_date IS NULL OR end_date > start_date)
);
ALTER TABLE parking_allocations
    ADD CONSTRAINT fk_parking_lease FOREIGN KEY (lease_id) REFERENCES leases(id);

CREATE TABLE lease_tenants (
    lease_id   uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id),
    is_primary boolean NOT NULL DEFAULT false,
    PRIMARY KEY (lease_id, contact_id)
);

CREATE TABLE lease_addons (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id     uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    type         text NOT NULL CHECK (type IN ('parking','storage','pet')),
    reference_id uuid,
    monthly_fee  numeric(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE document_instances (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES document_templates(id),
    unit_id     uuid REFERENCES units(id),
    contact_id  uuid REFERENCES contacts(id),
    lease_id    uuid REFERENCES leases(id),
    state       text NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','approved','sent','signed','void')),
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_values (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id uuid NOT NULL REFERENCES document_instances(id) ON DELETE CASCADE,
    field_key   text NOT NULL,
    value       text,
    filled_by   text CHECK (filled_by IN ('system','ai','staff')),
    UNIQUE (instance_id, field_key)
);

CREATE TABLE document_approvals (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id      uuid NOT NULL UNIQUE REFERENCES document_instances(id) ON DELETE CASCADE,
    approved_by      uuid NOT NULL REFERENCES users(id),
    approved_at      timestamptz NOT NULL DEFAULT now(),
    package_snapshot jsonb NOT NULL,           -- 核准當下的完整條件，爭議時可證明簽的是哪一版
    link_sent_at     timestamptz,
    link_expires_at  timestamptz
);

CREATE TABLE signatures (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id         uuid NOT NULL REFERENCES document_instances(id) ON DELETE CASCADE,
    signer_type         text NOT NULL CHECK (signer_type IN ('agent','tenant')),
    signer_user_id      uuid REFERENCES users(id),
    signer_contact_id   uuid REFERENCES contacts(id),
    signed_at           timestamptz,
    ip                  inet,
    provider_envelope_id text,
    CHECK (signer_user_id IS NOT NULL OR signer_contact_id IS NOT NULL)
);

CREATE TABLE fee_disclosures (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id      uuid NOT NULL REFERENCES contacts(id),
    unit_id         uuid NOT NULL REFERENCES units(id),
    monthly_total   numeric(10,2) NOT NULL,
    upfront_total   numeric(10,2) NOT NULL,
    line_items      jsonb NOT NULL,
    disclosed_at    timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz
);

CREATE TABLE inspections (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id             uuid NOT NULL REFERENCES leases(id),
    type                 text NOT NULL CHECK (type IN ('move_in','move_out')),
    scheduled_at         timestamptz,
    completed_at         timestamptz,
    document_instance_id uuid REFERENCES document_instances(id),
    UNIQUE (lease_id, type)
);
-- Alberta 規定入住與遷出均須完成書面檢查報告，缺其一將影響押金爭議的舉證。

-- ════════════════════════════════════════════════════════════
-- 8. 種子資料
-- ════════════════════════════════════════════════════════════

INSERT INTO roles (code, name) VALUES
    ('admin','管理者'), ('agent','租賃專員');

INSERT INTO permissions (code, description) VALUES
    ('pricing.view','檢視租金與費用結果'),
    ('pricing.edit','修改費用設定'),
    ('parking.allocate','配發與遞補車位'),
    ('parking.quota.edit','修改車位配額總數'),
    ('template.view','檢視文件範本'),
    ('template.edit','上傳與核定範本'),
    ('document.create','產生文件'),
    ('document.approve','簽核放行文件'),
    ('user.manage','管理帳號');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'agent'
  AND p.code IN ('pricing.view','parking.allocate','document.create','document.approve');

INSERT INTO buildings (code, name, address, storeys, unit_count, floor_area_sqm) VALUES
    ('370','Baydo Pointe 370','370 Clareview Station Drive NW, Edmonton, AB',6,118,1493.20),
    ('374','Baydo Pointe 374','374 Clareview Station Drive NW, Edmonton, AB',6, 94,1246.20),
    ('378','Baydo Pointe 378','378 Clareview Station Drive NW, Edmonton, AB',6,118,1493.20);

INSERT INTO unit_types (code, bedroom_label, bedrooms, area_sqft, area_sqm, balcony_sqft, is_mirrored) VALUES
    ('1C','1房',1,462.80,43,71,false),
    ('1A','1房',1,484.40,45,71,false),
    ('1A (M)','1房',1,484.40,45,71,true),
    ('1B','1房+書房',1,602.80,56,71,false),
    ('3A','2房+書房',3,731.90,68,71,false),
    ('3A (M)','2房+書房',3,731.90,68,71,true),
    ('2A','2房2衛',2,742.70,69,71,false),
    ('2A (M)','2房2衛',2,742.70,69,71,true);

INSERT INTO parking_pools (code, label, total_stalls, tandem_stalls, accessible_stalls, is_surface, note) VALUES
    ('u370','地下 · 370棟',52,0,0,false,NULL),
    ('u374','地下 · 374棟',62,16,0,false,'圖面標示待建商確認'),
    ('u378','地下 · 378棟',52,0,0,false,NULL),
    ('surface','地面 · 全案共用',56,0,6,true,NULL);

INSERT INTO amenities (name) VALUES
    ('健身房'),('Lounge／遊戲室'),('大廳'),('寵物清洗間'),('自行車儲藏室');
