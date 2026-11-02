-- صور لوتات مزادات أمريكا: تُرفع يدويًا وتُحفظ في القاعدة مثل صور السيارات، وتنتقل للسيارة عند «اشتريناها».
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS watch_lot_images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_lot_id  UUID NOT NULL REFERENCES watch_lots(id) ON DELETE CASCADE,
  content       BYTEA NOT NULL,
  mime          TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  bytes         INT NOT NULL,
  sha256        TEXT NOT NULL,
  width         INT,
  height        INT,
  sort_order    INT NOT NULL DEFAULT 0,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (watch_lot_id, sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watch_lot_primary_image ON watch_lot_images(watch_lot_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_watch_lot_images ON watch_lot_images(watch_lot_id, sort_order);
