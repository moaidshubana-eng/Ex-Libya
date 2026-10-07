-- =====================================================================
-- منظومة مزاد واستيراد السيارات (Car Import & Auction) — مخطط PostgreSQL
-- ---------------------------------------------------------------------
-- يغطي: السيارات وبياناتها الفنية والصور، مصادر الاستيراد (Copart/IAAI)
-- والمزامنة، الشحن البحري والحاويات، النقل الداخلي (أمريكا/ليبيا)،
-- الجمارك، المزادات الداخلية والمزايدات، المبيعات والمدفوعات،
-- التكاليف التفصيلية لكل سيارة (متعددة العملات)، وسجل التدقيق.
--
-- مبادئ التصميم:
--   * القيم المالية NUMERIC (لا FLOAT) — دقة 3 منازل عشرية لتوافق الدينار الليبي.
--   * كل تكلفة تحفظ سعر الصرف لحظة تسجيلها (snapshot) فلا يتغير التقرير
--     التاريخي إن تغيّر السعر لاحقًا.
--   * دورة حياة السيارة محكومة بجدول انتقالات مسموحة + Trigger: قاعدة البيانات
--     نفسها ترفض أي انتقال غير منطقي حتى لو أخطأ التطبيق.
--   * البيانات الشخصية الحساسة (الهاتف، رقم الهوية) مخزنة مشفّرة (AES-256-GCM
--     على مستوى التطبيق) مع بصمة HMAC للبحث المطابق دون فك التشفير.
--   * المصادر الخارجية معزولة في جداول خاصة (source_listings, sync_*) بحيث
--     يُضاف مصدر جديد بصف واحد في external_sources ومحوّل (Adapter) في الكود.
--
-- تشغيل: psql "$DATABASE_URL" -f db/schema.sql   (idempotent: يُسقط ويعيد البناء)
-- =====================================================================

BEGIN;

DROP SCHEMA IF EXISTS auction CASCADE;
CREATE SCHEMA auction;
SET search_path TO auction, public;

-- ---------------------------------------------------------------------
-- 1) الأنواع المعدّدة (Enums)
-- ---------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
  'ADMIN',        -- إدارة النظام والمستخدمين والتكاملات
  'OPERATIONS',   -- الشحن والجمارك والنقل وتحديث حالة السيارات
  'ACCOUNTANT',   -- التكاليف والمدفوعات والتقارير المالية
  'SALES',        -- إدارة المزادات والمبيعات والعملاء
  'VIEWER',       -- قراءة فقط (الإدارة العليا / المراجعة)
  'BIDDER'        -- عميل مزايد عبر البوابة (لا يرى التكاليف)
);

CREATE TYPE vehicle_status AS ENUM (
  'PURCHASED',          -- تم الشراء من المزاد الأمريكي
  'AWAITING_PICKUP',    -- بانتظار السحب من ساحة المزاد
  'US_INLAND_TRANSIT',  -- نقل داخلي في أمريكا (سحب إلى مستودع التصدير)
  'AT_US_WAREHOUSE',    -- في مستودع/ميناء التصدير بأمريكا
  'LOADED',             -- محمّلة في الحاوية / على السفينة
  'IN_TRANSIT_SEA',     -- في البحر
  'AT_PORT_LIBYA',      -- وصلت الميناء الليبي
  'IN_CUSTOMS',         -- قيد الإجراءات الجمركية
  'CUSTOMS_CLEARED',    -- تم الإفراج الجمركي
  'LY_INLAND_TRANSIT',  -- نقل داخلي في ليبيا (من الميناء إلى المعرض)
  'IN_STOCK',           -- في المعرض ومتاحة للبيع
  'IN_AUCTION',         -- معروضة في مزاد داخلي (مزايدة)
  'ON_HOLD',            -- معلقة (نزاع، نقص مستندات، ضرر…)
  'SOLD',               -- مباعة
  'DELIVERED',          -- مُسلَّمة للمشتري
  'CANCELLED'           -- أُلغيت (إلغاء الشراء من المصدر مثلًا)
);

CREATE TYPE title_type AS ENUM ('CLEAN','SALVAGE','REBUILT','PARTS_ONLY','CERTIFICATE_OF_DESTRUCTION','OTHER');
CREATE TYPE odometer_brand AS ENUM ('ACTUAL','NOT_ACTUAL','EXCEEDS_LIMIT','EXEMPT','UNKNOWN');
CREATE TYPE image_kind AS ENUM ('EXTERIOR','INTERIOR','DAMAGE','ENGINE','UNDERCARRIAGE','DOCUMENT','OTHER');
CREATE TYPE vendor_type AS ENUM ('AUCTION','TOWING','FREIGHT_FORWARDER','SHIPPING_LINE','INSURANCE','CUSTOMS_BROKER','INLAND_TRANSPORT','WORKSHOP','OTHER');
CREATE TYPE container_type AS ENUM ('C20','C40','C40HC','RORO');
CREATE TYPE shipment_status AS ENUM ('BOOKED','LOADING','DEPARTED','IN_TRANSIT','TRANSSHIPMENT','ARRIVED','DISCHARGED','CLOSED','CANCELLED');
CREATE TYPE transport_leg AS ENUM ('US_PICKUP','LY_DELIVERY','OTHER');
CREATE TYPE transport_status AS ENUM ('PLANNED','DISPATCHED','PICKED_UP','DELIVERED','CANCELLED');
CREATE TYPE customs_status AS ENUM ('DOCS_PENDING','SUBMITTED','INSPECTION','ASSESSED','DUTY_PAID','RELEASED','REJECTED');
CREATE TYPE document_type AS ENUM ('TITLE','BILL_OF_SALE','AUCTION_INVOICE','BILL_OF_LADING','DOCK_RECEIPT','INSURANCE','CUSTOMS_DECLARATION','CUSTOMS_RECEIPT','RELEASE_ORDER','SALE_INVOICE','OTHER');
CREATE TYPE auction_event_status AS ENUM ('DRAFT','SCHEDULED','LIVE','CLOSED','CANCELLED');
CREATE TYPE lot_status AS ENUM ('PENDING','OPEN','CLOSED_SOLD','CLOSED_UNSOLD','CANCELLED');
CREATE TYPE bid_kind AS ENUM ('MANUAL','PROXY');
CREATE TYPE deposit_status AS ENUM ('PENDING','HELD','RELEASED','APPLIED','FORFEITED');
CREATE TYPE sale_type AS ENUM ('AUCTION','DIRECT');
CREATE TYPE payment_method AS ENUM ('CASH','BANK_TRANSFER','CHEQUE','CARD','OTHER');
CREATE TYPE cost_stage AS ENUM ('PURCHASE','US_LOGISTICS','OCEAN','LIBYA_PORT','CUSTOMS','LIBYA_INLAND','PREPARATION','OVERHEAD');
CREATE TYPE cost_status AS ENUM ('ESTIMATED','ACTUAL');
CREATE TYPE allocation_method AS ENUM ('EQUAL','BY_PURCHASE_VALUE','MANUAL');
CREATE TYPE change_source AS ENUM ('MANUAL','SYNC','SYSTEM');
CREATE TYPE sync_job_type AS ENUM ('PURCHASES_IMPORT','LOT_REFRESH','IMAGES','SHIPMENT_TRACKING');
CREATE TYPE sync_job_status AS ENUM ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED');
CREATE TYPE customer_type AS ENUM ('INDIVIDUAL','DEALER','COMPANY');
CREATE TYPE kyc_status AS ENUM ('PENDING','VERIFIED','REJECTED','SUSPENDED');

-- ---------------------------------------------------------------------
-- 2) المستخدمون والعملاء
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name        TEXT NOT NULL,
  password_hash    TEXT NOT NULL,                 -- scrypt (N=2^15) مع ملح عشوائي
  role             user_role NOT NULL,
  customer_id      UUID,                          -- مطلوب للدور BIDDER فقط (FK أدناه)
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins    INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,                   -- قفل مؤقت بعد محاولات فاشلة متتالية
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bidder_has_customer CHECK (role <> 'BIDDER' OR customer_id IS NOT NULL)
);

CREATE TABLE user_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,              -- SHA-256 للرمز (الرمز نفسه لا يُخزَّن)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  ip           INET,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,          -- رقم العميل الداخلي C-00001
  full_name         TEXT NOT NULL,
  customer_type     customer_type NOT NULL DEFAULT 'INDIVIDUAL',
  phone_enc         TEXT,                          -- AES-256-GCM (iv:tag:ciphertext base64)
  phone_hash        TEXT,                          -- HMAC-SHA256 للبحث بالمطابقة التامة
  national_id_enc   TEXT,
  national_id_hash  TEXT UNIQUE,
  email             TEXT,
  city              TEXT,
  kyc_status        kyc_status NOT NULL DEFAULT 'PENDING',
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_phone_hash ON customers(phone_hash);
CREATE INDEX idx_customers_name ON customers USING gin (to_tsvector('simple', full_name));

ALTER TABLE users ADD CONSTRAINT fk_users_customer FOREIGN KEY (customer_id) REFERENCES customers(id);

-- ---------------------------------------------------------------------
-- 3) الجهات والموانئ والمصادر الخارجية
-- ---------------------------------------------------------------------

CREATE TABLE ports (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,                  -- UN/LOCODE مثل USHOU, LYMRA
  name      TEXT NOT NULL,
  name_ar   TEXT NOT NULL,
  country   CHAR(2) NOT NULL,
  is_origin BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE vendors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  vendor_type vendor_type NOT NULL,
  country     CHAR(2),
  contact     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- هاتف/بريد/شخص اتصال
  tracking    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- إعدادات API التتبع (بدون أسرار)
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, vendor_type)
);

-- مصدر بيانات خارجي: Copart, IAAI, ملف CSV يدوي… أي مصدر جديد = صف جديد + Adapter
CREATE TABLE external_sources (
  id                 SERIAL PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,         -- COPART | IAAI | CSV | MANUAL
  name               TEXT NOT NULL,
  adapter            TEXT NOT NULL,                -- اسم المحوّل في الكود
  base_url           TEXT,
  credentials_ref    TEXT,                         -- مرجع لخزنة الأسرار (لا يُخزن السر هنا)
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  sync_interval_sec  INT NOT NULL DEFAULT 900 CHECK (sync_interval_sec >= 60),
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  last_success_at    TIMESTAMPTZ,
  last_cursor        TEXT,                         -- مؤشر التزامن التزايدي (updated_since…)
  consecutive_failures INT NOT NULL DEFAULT 0,
  circuit_open_until TIMESTAMPTZ                   -- قاطع الدائرة: إيقاف مؤقت بعد فشل متكرر
);

-- ---------------------------------------------------------------------
-- 4) السيارات وبياناتها
-- ---------------------------------------------------------------------

CREATE TABLE vehicles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_no          TEXT NOT NULL UNIQUE,          -- رقم المخزون الداخلي LY-2026-0001
  vin               CHAR(17) NOT NULL UNIQUE CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  year              SMALLINT NOT NULL CHECK (year BETWEEN 1950 AND 2100),
  make              TEXT NOT NULL,
  model             TEXT NOT NULL,
  trim              TEXT,
  body_style        TEXT,
  exterior_color    TEXT,
  interior_color    TEXT,
  engine            TEXT,
  cylinders         SMALLINT,
  fuel_type         TEXT,
  transmission      TEXT,
  drive_type        TEXT,
  odometer          INT CHECK (odometer >= 0),
  odometer_unit     TEXT NOT NULL DEFAULT 'mi' CHECK (odometer_unit IN ('mi','km')),
  odometer_brand    odometer_brand NOT NULL DEFAULT 'UNKNOWN',
  title_type        title_type NOT NULL DEFAULT 'OTHER',
  title_state       CHAR(2),
  primary_damage    TEXT,
  secondary_damage  TEXT,
  has_keys          BOOLEAN,
  run_and_drive     BOOLEAN,
  condition_grade   NUMERIC(2,1) CHECK (condition_grade BETWEEN 0 AND 5),
  status            vehicle_status NOT NULL DEFAULT 'PURCHASED',
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hold_reason       TEXT,
  hold_return_status vehicle_status,               -- الحالة التي تعود إليها بعد رفع التعليق
  destination_port_id INT REFERENCES ports(id),
  list_price_lyd    NUMERIC(14,3),                 -- سعر العرض المقترح بالدينار
  locked_fields     TEXT[] NOT NULL DEFAULT '{}',  -- حقول عدّلها المستخدم يدويًا فلا تكتب فوقها المزامنة
  notes             TEXT,
  version           INT NOT NULL DEFAULT 1,        -- تزامن متفائل (Optimistic locking)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hold_requires_reason CHECK (status <> 'ON_HOLD' OR (hold_reason IS NOT NULL AND hold_return_status IS NOT NULL))
);
CREATE INDEX idx_vehicles_status ON vehicles(status);
CREATE INDEX idx_vehicles_created ON vehicles(created_at DESC, id);
CREATE INDEX idx_vehicles_make_model ON vehicles(make, model, year);
CREATE INDEX idx_vehicles_search ON vehicles USING gin (to_tsvector('simple', make || ' ' || model || ' ' || coalesce(trim,'') || ' ' || vin || ' ' || stock_no));

-- الانتقالات المسموحة في دورة الحياة (يقرؤها Trigger أدناه والتطبيق معًا)
CREATE TABLE vehicle_status_transitions (
  from_status vehicle_status NOT NULL,
  to_status   vehicle_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

CREATE TABLE vehicle_status_history (
  id           BIGSERIAL PRIMARY KEY,
  vehicle_id   UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  from_status  vehicle_status,
  to_status    vehicle_status NOT NULL,
  source       change_source NOT NULL DEFAULT 'MANUAL',
  reason       TEXT,
  changed_by   UUID REFERENCES users(id),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_status_history_vehicle ON vehicle_status_history(vehicle_id, occurred_at DESC);

-- بيانات القائمة في المصدر الخارجي (Lot) — سيارة واحدة قد تظهر في أكثر من مصدر/مزاد
CREATE TABLE source_listings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id         UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  source_id          INT NOT NULL REFERENCES external_sources(id),
  lot_number         TEXT NOT NULL,
  listing_url        TEXT,
  yard_name          TEXT,
  yard_state         CHAR(2),
  yard_zip           TEXT,
  sale_date          TIMESTAMPTZ,
  sale_status        TEXT,                         -- كما يرد من المصدر (Sold, Upcoming, On Approval…)
  acv_usd            NUMERIC(12,2),                -- القيمة النقدية الفعلية المقدّرة
  repair_estimate_usd NUMERIC(12,2),
  purchase_price_usd NUMERIC(12,2),
  buyer_account      TEXT,                         -- رقم حساب المشتري/الوسيط لدى المصدر
  payment_due_at     TIMESTAMPTZ,
  pickup_deadline_at TIMESTAMPTZ,                  -- بعدها تبدأ رسوم التخزين
  raw_payload        JSONB NOT NULL,               -- الحمولة الأصلية كما هي (للتدقيق وإعادة المعالجة)
  payload_hash       TEXT NOT NULL,                -- SHA-256 لتجنب إعادة المعالجة إن لم يتغير شيء
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, lot_number)
);
CREATE INDEX idx_listings_vehicle ON source_listings(vehicle_id);

CREATE TABLE vehicle_images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  source_id     INT REFERENCES external_sources(id), -- NULL = صورة داخلية (تصوير المعرض/الميناء)
  kind          image_kind NOT NULL DEFAULT 'EXTERIOR',
  original_url  TEXT,                               -- رابط المصدر الأصلي
  storage_key   TEXT NOT NULL,                      -- مفتاح التخزين في S3/MinIO (النسخة المحفوظة لدينا)
  width         INT,
  height        INT,
  bytes         INT,
  sha256        TEXT,                               -- لمنع تكرار نفس الصورة
  caption       TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, sha256)
);
CREATE UNIQUE INDEX uq_vehicle_primary_image ON vehicle_images(vehicle_id) WHERE is_primary;
CREATE INDEX idx_images_vehicle ON vehicle_images(vehicle_id, sort_order);

CREATE TABLE vehicle_inspections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL CHECK (stage IN ('US_PICKUP','US_WAREHOUSE','LIBYA_PORT','SHOWROOM','PRE_DELIVERY')),
  grade         NUMERIC(2,1) CHECK (grade BETWEEN 0 AND 5),
  findings      JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{part, issue, severity}]
  notes         TEXT,
  inspected_by  UUID REFERENCES users(id),
  inspected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5) الشحن البحري والنقل والجمارك
-- ---------------------------------------------------------------------

CREATE TABLE shipments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_no      TEXT NOT NULL UNIQUE,            -- SH-2026-0001
  booking_no       TEXT,
  bill_of_lading   TEXT UNIQUE,
  container_no     TEXT CHECK (container_no IS NULL OR container_no ~ '^[A-Z]{4}[0-9]{7}$'), -- ISO 6346
  container_type   container_type NOT NULL DEFAULT 'C40HC',
  capacity         SMALLINT NOT NULL DEFAULT 4 CHECK (capacity > 0),
  carrier_id       UUID REFERENCES vendors(id),     -- الخط الملاحي
  forwarder_id     UUID REFERENCES vendors(id),     -- وكيل الشحن
  vessel_name      TEXT,
  voyage_no        TEXT,
  pol_port_id      INT NOT NULL REFERENCES ports(id), -- ميناء التحميل
  pod_port_id      INT NOT NULL REFERENCES ports(id), -- ميناء التفريغ
  etd              DATE,
  atd              DATE,
  eta              DATE,
  ata              DATE,
  status           shipment_status NOT NULL DEFAULT 'BOOKED',
  last_tracking_at TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pol_port_id <> pod_port_id)
);
CREATE INDEX idx_shipments_status ON shipments(status, eta);

CREATE TABLE shipment_vehicles (
  shipment_id  UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  vehicle_id   UUID NOT NULL REFERENCES vehicles(id),
  position     SMALLINT,                            -- ترتيب السيارة داخل الحاوية
  loaded_at    TIMESTAMPTZ,
  PRIMARY KEY (shipment_id, vehicle_id)
);
CREATE UNIQUE INDEX uq_vehicle_single_shipment ON shipment_vehicles(vehicle_id); -- السيارة تُشحن مرة واحدة

CREATE TABLE shipment_events (
  id            BIGSERIAL PRIMARY KEY,
  shipment_id   UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  event_code    TEXT NOT NULL,                      -- GATE_IN, LOADED, DEPARTED, ARRIVED, DISCHARGED…
  description   TEXT,
  location      TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  source        change_source NOT NULL DEFAULT 'MANUAL',
  external_id   TEXT,
  UNIQUE (shipment_id, event_code, occurred_at)     -- منع تكرار نفس الحدث من التتبع الآلي
);

CREATE TABLE inland_transports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  leg            transport_leg NOT NULL,
  vendor_id      UUID REFERENCES vendors(id),
  from_location  TEXT NOT NULL,
  to_location    TEXT NOT NULL,
  distance_km    NUMERIC(8,1),
  planned_at     DATE,
  picked_up_at   TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  status         transport_status NOT NULL DEFAULT 'PLANNED',
  driver_info    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (delivered_at IS NULL OR picked_up_at IS NULL OR delivered_at >= picked_up_at)
);
CREATE INDEX idx_transport_vehicle ON inland_transports(vehicle_id);

CREATE TABLE customs_declarations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id         UUID NOT NULL UNIQUE REFERENCES vehicles(id) ON DELETE CASCADE,
  declaration_no     TEXT UNIQUE,
  port_id            INT NOT NULL REFERENCES ports(id),
  broker_id          UUID REFERENCES vendors(id),   -- المخلص الجمركي
  status             customs_status NOT NULL DEFAULT 'DOCS_PENDING',
  submitted_at       TIMESTAMPTZ,
  assessed_value_lyd NUMERIC(14,3),
  duty_amount_lyd    NUMERIC(14,3),                 -- الرسم المحتسب (يُسجّل أيضًا كتكلفة في vehicle_costs)
  released_at        TIMESTAMPTZ,
  rejection_reason   TEXT,
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customs_status ON customs_declarations(status);

CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  shipment_id   UUID REFERENCES shipments(id) ON DELETE CASCADE,
  customs_id    UUID REFERENCES customs_declarations(id) ON DELETE CASCADE,
  doc_type      document_type NOT NULL,
  file_name     TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(vehicle_id, shipment_id, customs_id) >= 1)
);

-- ---------------------------------------------------------------------
-- 6) المزادات الداخلية والمزايدات
-- ---------------------------------------------------------------------

CREATE TABLE auction_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT NOT NULL,
  starts_at            TIMESTAMPTZ NOT NULL,
  ends_at              TIMESTAMPTZ NOT NULL,
  status               auction_event_status NOT NULL DEFAULT 'DRAFT',
  anti_snipe_window_sec INT NOT NULL DEFAULT 120 CHECK (anti_snipe_window_sec >= 0),
  extension_sec        INT NOT NULL DEFAULT 120 CHECK (extension_sec >= 0),
  deposit_required_lyd NUMERIC(14,3) NOT NULL DEFAULT 0,
  currency             CHAR(3) NOT NULL DEFAULT 'LYD',
  terms                TEXT,
  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE auction_lots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_event_id    UUID NOT NULL REFERENCES auction_events(id) ON DELETE CASCADE,
  vehicle_id          UUID NOT NULL REFERENCES vehicles(id),
  lot_no              INT NOT NULL,
  starting_price      NUMERIC(14,3) NOT NULL CHECK (starting_price > 0),
  reserve_price       NUMERIC(14,3),                -- سعر أدنى سري؛ لا يُعرض للمزايدين
  current_price       NUMERIC(14,3),
  leading_customer_id UUID REFERENCES customers(id),
  bid_count           INT NOT NULL DEFAULT 0,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,          -- يتمدد آليًا عند المزايدة في الدقائق الأخيرة
  original_ends_at    TIMESTAMPTZ NOT NULL,
  status              lot_status NOT NULL DEFAULT 'PENDING',
  version             INT NOT NULL DEFAULT 1,
  closed_at           TIMESTAMPTZ,
  UNIQUE (auction_event_id, lot_no),
  CHECK (reserve_price IS NULL OR reserve_price >= starting_price),
  CHECK (ends_at > starts_at)
);
-- لا يجوز عرض السيارة في أكثر من مزاد مفتوح في الوقت نفسه
CREATE UNIQUE INDEX uq_vehicle_active_lot ON auction_lots(vehicle_id) WHERE status IN ('PENDING','OPEN');
CREATE INDEX idx_lots_open ON auction_lots(status, ends_at);

CREATE TABLE bidder_registrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_event_id  UUID NOT NULL REFERENCES auction_events(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id),
  paddle_no         INT NOT NULL,
  deposit_amount_lyd NUMERIC(14,3) NOT NULL DEFAULT 0,
  deposit_status    deposit_status NOT NULL DEFAULT 'PENDING',
  approved_by       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  UNIQUE (auction_event_id, customer_id),
  UNIQUE (auction_event_id, paddle_no)
);

CREATE TABLE bids (
  id           BIGSERIAL PRIMARY KEY,
  lot_id       UUID NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id),
  amount       NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  kind         bid_kind NOT NULL DEFAULT 'MANUAL',
  placed_by    UUID REFERENCES users(id),           -- موظف أدخلها نيابة عن العميل (مزاد هجين) أو العميل نفسه
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ip_hash      TEXT,
  idempotency_key TEXT,
  UNIQUE (lot_id, amount),                           -- لا مزايدتان بنفس المبلغ على نفس السيارة
  UNIQUE (lot_id, customer_id, idempotency_key)      -- إعادة الإرسال عند انقطاع الشبكة لا تكرر المزايدة
);
CREATE INDEX idx_bids_lot ON bids(lot_id, amount DESC);

-- المزايدة الآلية (Proxy): العميل يحدد حدًا أقصى سريًا والنظام يزايد عنه بأقل زيادة
CREATE TABLE proxy_bids (
  lot_id       UUID NOT NULL REFERENCES auction_lots(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id),
  max_amount   NUMERIC(14,3) NOT NULL CHECK (max_amount > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (lot_id, customer_id)
);

-- ---------------------------------------------------------------------
-- 7) المبيعات والمدفوعات
-- ---------------------------------------------------------------------

-- ترقيم فواتير متسلسل بلا فجوات منطقية بين النسخ (تسلسل قاعدة البيانات لا عدّاد في الذاكرة)
CREATE SEQUENCE invoice_seq;
CREATE SEQUENCE stock_seq;
CREATE SEQUENCE shipment_seq;

CREATE TABLE sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no      TEXT NOT NULL UNIQUE,              -- INV-2026-00001
  vehicle_id      UUID NOT NULL UNIQUE REFERENCES vehicles(id),
  customer_id     UUID NOT NULL REFERENCES customers(id),
  lot_id          UUID UNIQUE REFERENCES auction_lots(id),
  sale_type       sale_type NOT NULL,
  sale_price_lyd  NUMERIC(14,3) NOT NULL CHECK (sale_price_lyd > 0),
  buyer_fee_lyd   NUMERIC(14,3) NOT NULL DEFAULT 0,
  sold_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_due_at  TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  CHECK (sale_type <> 'AUCTION' OR lot_id IS NOT NULL)
);

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       UUID NOT NULL REFERENCES sales(id),
  amount        NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  currency      CHAR(3) NOT NULL DEFAULT 'LYD',
  fx_rate_to_lyd NUMERIC(14,6) NOT NULL DEFAULT 1,
  method        payment_method NOT NULL,
  reference     TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by   UUID REFERENCES users(id)
);
CREATE INDEX idx_payments_sale ON payments(sale_id);

-- ---------------------------------------------------------------------
-- 8) التكاليف التفصيلية لكل سيارة
-- ---------------------------------------------------------------------

CREATE TABLE cost_categories (
  code         TEXT PRIMARY KEY,
  name_ar      TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  stage        cost_stage NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE exchange_rates (
  id             SERIAL PRIMARY KEY,
  currency       CHAR(3) NOT NULL CHECK (currency <> 'LYD'),
  rate_to_lyd    NUMERIC(14,6) NOT NULL CHECK (rate_to_lyd > 0),  -- كم دينار مقابل وحدة واحدة
  effective_date DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'MANUAL',
  UNIQUE (currency, effective_date)
);

-- تكلفة مشتركة على مستوى الشحنة (أجرة الحاوية مثلًا) تُوزَّع على سياراتها
CREATE TABLE shared_costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id     UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  category_code   TEXT NOT NULL REFERENCES cost_categories(code),
  vendor_id       UUID REFERENCES vendors(id),
  description     TEXT,
  total_amount    NUMERIC(14,3) NOT NULL CHECK (total_amount > 0),
  currency        CHAR(3) NOT NULL,
  fx_rate_to_lyd  NUMERIC(14,6) NOT NULL CHECK (fx_rate_to_lyd > 0),
  method          allocation_method NOT NULL DEFAULT 'EQUAL',
  incurred_at     DATE NOT NULL,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  category_code   TEXT NOT NULL REFERENCES cost_categories(code),
  vendor_id       UUID REFERENCES vendors(id),
  shared_cost_id  UUID REFERENCES shared_costs(id) ON DELETE CASCADE, -- إن كانت حصة من تكلفة مشتركة
  description     TEXT,
  amount          NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL,
  fx_rate_to_lyd  NUMERIC(14,6) NOT NULL CHECK (fx_rate_to_lyd > 0),  -- لقطة سعر الصرف وقت التسجيل
  amount_lyd      NUMERIC(14,3) GENERATED ALWAYS AS (round(amount * fx_rate_to_lyd, 3)) STORED,
  status          cost_status NOT NULL DEFAULT 'ACTUAL',
  invoice_ref     TEXT,
  incurred_at     DATE NOT NULL,
  is_paid         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,                      -- لا حذف فعلي: الإلغاء يُسجَّل مع السبب
  voided_by       UUID REFERENCES users(id),
  void_reason     TEXT,
  CHECK (currency <> 'LYD' OR fx_rate_to_lyd = 1),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX idx_costs_vehicle ON vehicle_costs(vehicle_id) WHERE voided_at IS NULL;
CREATE INDEX idx_costs_category ON vehicle_costs(category_code, incurred_at);

-- ---------------------------------------------------------------------
-- 9) التكامل والمزامنة
-- ---------------------------------------------------------------------

CREATE TABLE sync_jobs (
  id             BIGSERIAL PRIMARY KEY,
  source_id      INT NOT NULL REFERENCES external_sources(id),
  job_type       sync_job_type NOT NULL,
  status         sync_job_status NOT NULL DEFAULT 'QUEUED',
  triggered_by   TEXT NOT NULL DEFAULT 'SCHEDULER',  -- SCHEDULER | USER:<id> | WEBHOOK
  cursor_from    TEXT,
  cursor_to      TEXT,
  items_seen     INT NOT NULL DEFAULT 0,
  items_created  INT NOT NULL DEFAULT 0,
  items_updated  INT NOT NULL DEFAULT 0,
  items_unchanged INT NOT NULL DEFAULT 0,
  items_failed   INT NOT NULL DEFAULT 0,
  attempt        INT NOT NULL DEFAULT 1,
  error          TEXT,
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX idx_sync_jobs_source ON sync_jobs(source_id, queued_at DESC);
-- مهمة واحدة جارية لكل (مصدر، نوع) — يمنع تداخل جولتي مزامنة
CREATE UNIQUE INDEX uq_sync_running ON sync_jobs(source_id, job_type) WHERE status IN ('QUEUED','RUNNING');

-- طابور الرسائل الفاشلة (Dead-letter): عنصر فشل بعد كل المحاولات يُحفظ هنا لإعادة المعالجة يدويًا
CREATE TABLE sync_dead_letters (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT REFERENCES sync_jobs(id) ON DELETE SET NULL,
  source_id     INT NOT NULL REFERENCES external_sources(id),
  external_ref  TEXT NOT NULL,                       -- رقم اللوت مثلًا
  payload       JSONB,
  error         TEXT NOT NULL,
  attempts      INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES users(id)
);
-- عنصر واحد مفتوح لكل (مصدر، مرجع): تكرار الفشل يزيد عدد المحاولات بدل تكرار الصفوف
CREATE UNIQUE INDEX uq_dead_letter_open ON sync_dead_letters(source_id, external_ref) WHERE resolved_at IS NULL;

-- صندوق الأحداث الواردة (Webhooks) — UNIQUE يضمن المعالجة مرة واحدة (Idempotency)
CREATE TABLE inbound_events (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          INT NOT NULL REFERENCES external_sources(id),
  external_event_id  TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  payload            JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  error              TEXT,
  UNIQUE (source_id, external_event_id)
);

-- ---------------------------------------------------------------------
-- 10) سجل التدقيق
-- ---------------------------------------------------------------------

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,                         -- VEHICLE_STATUS_CHANGED, COST_ADDED, BID_PLACED…
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_data JSONB,
  after_data  JSONB,
  ip          INET,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id, at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, at DESC);

-- سجل التدقيق للإلحاق فقط: يُمنع التعديل والحذف على مستوى قاعدة البيانات
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ---------------------------------------------------------------------
-- 11) قواعد الأعمال على مستوى قاعدة البيانات (Triggers)
-- ---------------------------------------------------------------------

-- التحقق من انتقالات حالة السيارة
CREATE FUNCTION enforce_vehicle_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'ON_HOLD' THEN
      IF OLD.status IN ('SOLD','DELIVERED','CANCELLED') THEN
        RAISE EXCEPTION 'لا يمكن تعليق سيارة في الحالة %', OLD.status USING ERRCODE = 'check_violation';
      END IF;
      NEW.hold_return_status := OLD.status;
    ELSIF OLD.status = 'ON_HOLD' THEN
      IF NEW.status NOT IN (OLD.hold_return_status, 'CANCELLED') THEN
        RAISE EXCEPTION 'رفع التعليق يعيد السيارة إلى % فقط', OLD.hold_return_status USING ERRCODE = 'check_violation';
      END IF;
      NEW.hold_reason := NULL;
      NEW.hold_return_status := NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM vehicle_status_transitions t
                      WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
      RAISE EXCEPTION 'انتقال غير مسموح: % ← %', NEW.status, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_vehicle_status BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION enforce_vehicle_status_transition();

-- منع تجاوز سعة الحاوية
CREATE FUNCTION enforce_container_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap INT; cnt INT;
BEGIN
  SELECT capacity INTO cap FROM shipments WHERE id = NEW.shipment_id FOR UPDATE;
  SELECT count(*) INTO cnt FROM shipment_vehicles WHERE shipment_id = NEW.shipment_id;
  IF cnt >= cap THEN
    RAISE EXCEPTION 'الحاوية ممتلئة (السعة %)', cap USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_container_capacity BEFORE INSERT ON shipment_vehicles
  FOR EACH ROW EXECUTE FUNCTION enforce_container_capacity();

-- ---------------------------------------------------------------------
-- 12) العروض (Views) للتقارير
-- ---------------------------------------------------------------------

-- التكلفة الواصلة (Landed cost) لكل سيارة مفصلة حسب المرحلة + الربحية
CREATE VIEW v_vehicle_landed_cost AS
SELECT
  v.id AS vehicle_id, v.stock_no, v.vin, v.year, v.make, v.model, v.status,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'PURCHASE'), 0)      AS purchase_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'US_LOGISTICS'), 0)  AS us_logistics_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'OCEAN'), 0)         AS ocean_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'LIBYA_PORT'), 0)    AS libya_port_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'CUSTOMS'), 0)       AS customs_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'LIBYA_INLAND'), 0)  AS libya_inland_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'PREPARATION'), 0)   AS preparation_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE cc.stage = 'OVERHEAD'), 0)      AS overhead_lyd,
  COALESCE(sum(c.amount_lyd), 0)                                           AS total_cost_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE c.status = 'ESTIMATED'), 0)     AS estimated_part_lyd,
  COALESCE(sum(c.amount_lyd) FILTER (WHERE NOT c.is_paid), 0)              AS unpaid_lyd,
  s.sale_price_lyd,
  s.sale_price_lyd - COALESCE(sum(c.amount_lyd), 0)                        AS margin_lyd
FROM vehicles v
LEFT JOIN vehicle_costs c ON c.vehicle_id = v.id AND c.voided_at IS NULL
LEFT JOIN cost_categories cc ON cc.code = c.category_code
LEFT JOIN sales s ON s.vehicle_id = v.id
-- تضمين الأعمدة الوصفية في GROUP BY يسمح لـ PostgreSQL بدفع مرشحات (الحالة/الماركة/المعرّف)
-- إلى ما قبل التجميع، فلا يُجمَّع كامل جدول التكاليف عند طلب جزء من الأسطول
GROUP BY v.id, v.stock_no, v.vin, v.year, v.make, v.model, v.status, s.sale_price_lyd;

-- آخر موقع معروف لكل سيارة (شحنة + جمارك + نقل) — يغذي شاشة التتبع
CREATE VIEW v_vehicle_tracking AS
SELECT v.id AS vehicle_id, v.stock_no, v.vin, v.status,
       sh.shipment_no, sh.container_no, sh.vessel_name, sh.status AS shipment_status,
       sh.etd, sh.eta, sh.ata, pol.code AS pol, pod.code AS pod,
       cd.status AS customs_status, cd.declaration_no
FROM vehicles v
LEFT JOIN shipment_vehicles sv ON sv.vehicle_id = v.id
LEFT JOIN shipments sh ON sh.id = sv.shipment_id
LEFT JOIN ports pol ON pol.id = sh.pol_port_id
LEFT JOIN ports pod ON pod.id = sh.pod_port_id
LEFT JOIN customs_declarations cd ON cd.vehicle_id = v.id;

-- ---------------------------------------------------------------------
-- 13) بيانات مرجعية ثابتة
-- ---------------------------------------------------------------------

INSERT INTO vehicle_status_transitions (from_status, to_status) VALUES
  ('PURCHASED','AWAITING_PICKUP'), ('PURCHASED','CANCELLED'),
  ('AWAITING_PICKUP','US_INLAND_TRANSIT'), ('AWAITING_PICKUP','CANCELLED'),
  ('US_INLAND_TRANSIT','AT_US_WAREHOUSE'),
  ('AT_US_WAREHOUSE','LOADED'),
  ('LOADED','IN_TRANSIT_SEA'), ('LOADED','AT_US_WAREHOUSE'),
  ('IN_TRANSIT_SEA','AT_PORT_LIBYA'),
  ('AT_PORT_LIBYA','IN_CUSTOMS'),
  ('IN_CUSTOMS','CUSTOMS_CLEARED'),
  ('CUSTOMS_CLEARED','LY_INLAND_TRANSIT'), ('CUSTOMS_CLEARED','IN_STOCK'),
  ('LY_INLAND_TRANSIT','IN_STOCK'),
  ('IN_STOCK','IN_AUCTION'), ('IN_STOCK','SOLD'),
  ('IN_AUCTION','IN_STOCK'), ('IN_AUCTION','SOLD'),
  -- البيع المسبق: تُباع السيارة وهي في الطريق أو في الميناء
  ('IN_TRANSIT_SEA','SOLD'), ('AT_PORT_LIBYA','SOLD'), ('IN_CUSTOMS','SOLD'), ('CUSTOMS_CLEARED','SOLD'),
  ('SOLD','DELIVERED');

INSERT INTO cost_categories (code, name_ar, name_en, stage, sort_order) VALUES
  ('HAMMER_PRICE',     'سعر الشراء في المزاد',          'Hammer price',              'PURCHASE', 10),
  ('AUCTION_BUYER_FEE','رسوم المشتري للمزاد',            'Auction buyer fee',         'PURCHASE', 20),
  ('AUCTION_OTHER_FEES','رسوم مزاد أخرى (بوابة/بيئة/إنترنت)','Gate/environmental/virtual bid fees','PURCHASE', 30),
  ('BROKER_FEE',       'عمولة الوسيط/حساب المزاد',      'Broker / account fee',      'PURCHASE', 40),
  ('US_TOWING',        'السحب الداخلي في أمريكا',        'US inland towing',          'US_LOGISTICS', 50),
  ('US_STORAGE',       'تخزين/غرامات تأخير في الساحة',   'Yard storage / late fees',  'US_LOGISTICS', 60),
  ('EXPORT_DOCS',      'مستندات التصدير والملكية',       'Export & title docs',       'US_LOGISTICS', 70),
  ('OCEAN_FREIGHT',    'الشحن البحري',                  'Ocean freight',             'OCEAN', 80),
  ('LOADING',          'التحميل والتربيط في الحاوية',    'Container loading',         'OCEAN', 90),
  ('MARINE_INSURANCE', 'التأمين البحري',                'Marine insurance',          'OCEAN', 100),
  ('PORT_HANDLING',    'رسوم الميناء والتفريغ',          'Port handling & discharge', 'LIBYA_PORT', 110),
  ('PORT_STORAGE',     'أرضيات الميناء',                'Port storage',              'LIBYA_PORT', 120),
  ('CUSTOMS_DUTY',     'الرسوم الجمركية',               'Customs duty',              'CUSTOMS', 130),
  ('CUSTOMS_BROKER',   'أتعاب التخليص الجمركي',          'Customs broker fee',        'CUSTOMS', 140),
  ('LY_TRANSPORT',     'النقل الداخلي في ليبيا',         'Libya inland transport',    'LIBYA_INLAND', 150),
  ('REPAIRS',          'إصلاح وصيانة',                  'Repairs',                   'PREPARATION', 160),
  ('PARTS',            'قطع غيار',                      'Parts',                     'PREPARATION', 170),
  ('REGISTRATION',     'ترقيم وتسجيل',                  'Registration & plates',     'PREPARATION', 180),
  ('OTHER',            'مصاريف أخرى',                   'Other',                     'OVERHEAD', 190);

INSERT INTO ports (code, name, name_ar, country, is_origin) VALUES
  ('USHOU','Houston, TX','هيوستن','US', TRUE),
  ('USSAV','Savannah, GA','سافانا','US', TRUE),
  ('USNYC','New York / Newark, NJ','نيويورك/نيوارك','US', TRUE),
  ('USLAX','Los Angeles, CA','لوس أنجلوس','US', TRUE),
  ('USBAL','Baltimore, MD','بالتيمور','US', TRUE),
  ('LYMRA','Misrata','مصراتة','LY', FALSE),
  ('LYTIP','Tripoli','طرابلس','LY', FALSE),
  ('LYBEN','Benghazi','بنغازي','LY', FALSE),
  ('LYKHO','Al Khums','الخمس','LY', FALSE);

INSERT INTO external_sources (code, name, adapter, base_url, sync_interval_sec, rate_limit_per_min) VALUES
  ('COPART','Copart','copart', NULL, 900, 60),
  ('IAAI','Insurance Auto Auctions (IAAI)','iaai', NULL, 900, 60),
  ('TRACKING','تتبع الحاويات (DCSA)','tracking', NULL, 3600, 30),
  ('CSV','استيراد ملف (CSV/Excel)','csv', NULL, 86400, 1000),
  ('MANUAL','إدخال يدوي','manual', NULL, 86400, 1000);

COMMIT;
