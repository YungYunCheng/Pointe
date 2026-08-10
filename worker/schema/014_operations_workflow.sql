BEGIN;

/*
 * Floor plans can point at a hosted tour now (Matterport, CloudPano, etc.)
 * and at a company-server object later.  The public site only exposes the
 * HTTPS URL; the storage key is private staff metadata.
 */
ALTER TABLE unit_types
  ADD COLUMN IF NOT EXISTS virtual_tour_url TEXT,
  ADD COLUMN IF NOT EXISTS virtual_tour_provider TEXT,
  ADD COLUMN IF NOT EXISTS virtual_tour_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS virtual_tour_updated_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS virtual_tour_updated_at TIMESTAMPTZ;

INSERT INTO permissions (code, description) VALUES
  ('floorplans.manage', 'Manage floor-plan virtual tours'),
  ('contracts.archive', 'Queue signed contracts for company-server archiving')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('admin', 'floorplans.manage'),
  ('property_manager', 'floorplans.manage'),
  ('admin', 'contracts.archive'),
  ('property_manager', 'contracts.archive')
ON CONFLICT DO NOTHING;

/* Unit availability is shared operational information. Admin and Property
 * Manager may change it; Building Manager and Accounting are read-only. */
DELETE FROM role_permissions
WHERE role_code = 'building_manager' AND permission_code = 'units.status.edit';

/* Schedule ownership is stored with the event so Admin can see and filter the
 * whole team's calendar rather than whatever happens to be in one browser. */
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS confirmation_state TEXT NOT NULL DEFAULT 'none'
    CHECK (confirmation_state IN ('none','sent','confirmed','declined')),
  ADD COLUMN IF NOT EXISTS confirmation_channel TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signing_state TEXT
    CHECK (signing_state IN ('pending_review','approved','sent','signed')),
  ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

/* Human approval remains the boundary between a recommendation and a job. */
ALTER TABLE maintenance
  ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_state IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_note TEXT,
  ADD COLUMN IF NOT EXISTS recommended_vendor_id TEXT REFERENCES vendors(id),
  ADD COLUMN IF NOT EXISTS recommendation_reason TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_score NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS assigned_vendor_id TEXT REFERENCES vendors(id),
  ADD COLUMN IF NOT EXISTS assignment_source TEXT
    CHECK (assignment_source IN ('system_recommendation','manual')),
  ADD COLUMN IF NOT EXISTS assigned_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS assigned_name TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_maintenance_approval
  ON maintenance(approval_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_vendor
  ON maintenance(assigned_vendor_id, state);

/* Which vendors cover which work.  Empty coverage means the vendor remains
 * available for manual selection but is not preferred by the recommender. */
CREATE TABLE IF NOT EXISTS vendor_service_coverage (
  id             TEXT PRIMARY KEY,
  vendor_id      TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  building_code  TEXT REFERENCES buildings(code),
  preference     INTEGER NOT NULL DEFAULT 0,
  is_available   BOOLEAN NOT NULL DEFAULT TRUE,
  max_job_amount NUMERIC(14,2),
  note           TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (vendor_id, category, building_code)
);
CREATE INDEX IF NOT EXISTS idx_vendor_coverage
  ON vendor_service_coverage(category, building_code, is_available);

/* Quotes already existed, but selection state and its audit trail did not. */
ALTER TABLE vendor_quotes
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','selected','rejected','expired','withdrawn')),
  ADD COLUMN IF NOT EXISTS selected_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS selected_name TEXT,
  ADD COLUMN IF NOT EXISTS selected_at TIMESTAMPTZ;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS quote_id TEXT REFERENCES vendor_quotes(id),
  ADD COLUMN IF NOT EXISTS issued_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS issued_name TEXT,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_selected_quote_per_ticket
  ON vendor_quotes(ticket_id) WHERE state = 'selected';

/* A completed signature produces an archive record and a delivery job.  The
 * job deliberately waits until the company-server connector is configured;
 * no row may claim a file was stored when it was not. */
CREATE TABLE IF NOT EXISTS signed_contract_archives (
  id                   TEXT PRIMARY KEY,
  signature_request_id TEXT NOT NULL REFERENCES signature_requests(id),
  lease_id             TEXT REFERENCES leases(id),
  unit_number          TEXT,
  source_key           TEXT NOT NULL,
  source_sha256        TEXT NOT NULL,
  certificate_key      TEXT,
  destination_provider TEXT NOT NULL DEFAULT 'company_server',
  destination_key      TEXT,
  state                TEXT NOT NULL DEFAULT 'awaiting_connection'
    CHECK (state IN ('awaiting_connection','queued','storing','stored','failed')),
  last_error           TEXT,
  queued_by            TEXT REFERENCES users(id),
  queued_name          TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stored_at TIMESTAMPTZ,
  UNIQUE (signature_request_id)
);
CREATE INDEX IF NOT EXISTS idx_contract_archive_state
  ON signed_contract_archives(state, queued_at);

CREATE TABLE IF NOT EXISTS contract_storage_jobs (
  id          TEXT PRIMARY KEY,
  archive_id  TEXT NOT NULL REFERENCES signed_contract_archives(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  UNIQUE (archive_id)
);

/* Admin is intentionally a super-role. Keep this at the end so every
 * permission introduced by this migration is granted even on an older
 * database whose original Admin seed ran before the permission existed. */
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

COMMIT;
