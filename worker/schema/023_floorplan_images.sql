BEGIN;

-- Floor-plan artwork is stored privately in R2. The public API streams the
-- image by unit-type code, so storage keys are never exposed to browsers.
ALTER TABLE unit_types
  ADD COLUMN IF NOT EXISTS floorplan_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS floorplan_filename TEXT,
  ADD COLUMN IF NOT EXISTS floorplan_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS floorplan_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS floorplan_updated_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS floorplan_updated_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE unit_types ADD CONSTRAINT unit_types_floorplan_size_positive
    CHECK (floorplan_size_bytes IS NULL OR floorplan_size_bytes > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
