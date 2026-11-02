-- مزادات أمريكا: سيارات نتابعها في Copart/IAAI قبل شرائها (سعر المزاد، موعده، الولاية والمدينة…).
-- لا تدخل دورة حياة السيارة ولا التكاليف: عند الشراء تُحوَّل إلى سيارة عادية ويُربط اللوت بها.
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS watch_lots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT NOT NULL CHECK (source IN ('COPART','IAAI','OTHER')),
  lot_number       TEXT NOT NULL CHECK (lot_number ~ '^[0-9A-Za-z-]{3,20}$'),
  lot_url          TEXT CHECK (lot_url IS NULL OR lot_url ~ '^https?://'),
  vin              TEXT,                                   -- قد يكون ناقصًا (المزاد يخفي آخر 6 خانات)
  year             INT CHECK (year BETWEEN 1950 AND 2100),
  make             TEXT,
  model            TEXT,
  trim             TEXT,
  odometer         INT CHECK (odometer >= 0),
  odometer_unit    TEXT NOT NULL DEFAULT 'mi' CHECK (odometer_unit IN ('mi','km')),
  primary_damage   TEXT,
  title_doc        TEXT,                                   -- كما في المزاد: SALVAGE (TX)، CLEAN…
  run_status       TEXT CHECK (run_status IN ('RUN_DRIVE','STARTS','STATIONARY','UNKNOWN')),
  has_keys         BOOLEAN,
  us_state         CHAR(2) CHECK (us_state ~ '^[A-Z]{2}$'),
  city             TEXT,
  branch           TEXT,                                   -- فرع/ساحة المزاد
  auction_at       TIMESTAMPTZ,                            -- موعد بدء المزاد
  current_bid_usd  NUMERIC(14,3) CHECK (current_bid_usd >= 0),
  buy_now_usd      NUMERIC(14,3) CHECK (buy_now_usd > 0),
  est_value_usd    NUMERIC(14,3) CHECK (est_value_usd > 0),  -- القيمة التقديرية (ACV)
  max_bid_usd      NUMERIC(14,3) CHECK (max_bid_usd > 0),    -- أقصى سعر نقبل به
  status           TEXT NOT NULL DEFAULT 'WATCHING' CHECK (status IN ('WATCHING','WON','LOST','DROPPED','PURCHASED')),
  final_price_usd  NUMERIC(14,3) CHECK (final_price_usd > 0),
  vehicle_id       UUID REFERENCES vehicles(id),
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  updated_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, lot_number),
  CHECK ((status = 'PURCHASED') = (vehicle_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_watch_lots_open ON watch_lots(auction_at) WHERE status = 'WATCHING';
