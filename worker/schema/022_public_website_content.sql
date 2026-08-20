BEGIN;

-- Editable copy for the public leasing website.  The image bytes live in R2;
-- Supabase only keeps the publishing metadata and ordering.
CREATE TABLE IF NOT EXISTS public_site_settings (
  id          TEXT PRIMARY KEY CHECK (id = 'main'),
  content     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_site_images (
  id           TEXT PRIMARY KEY,
  slot         TEXT NOT NULL
               CHECK (slot IN ('hero','amenities','neighbourhood','gallery')),
  storage_key  TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  alt_en       TEXT NOT NULL DEFAULT '',
  alt_zh       TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_public_site_images_live
  ON public_site_images (slot, sort_order, created_at) WHERE is_active;

INSERT INTO public_site_settings (id, content)
VALUES ('main', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public_site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_site_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public_site_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_site_images FORCE ROW LEVEL SECURITY;

COMMIT;
