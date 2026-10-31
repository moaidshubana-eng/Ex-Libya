-- حسابات العملاء والموردين:
--  - كل سيارة يمكن أن تُشترى لعميل بسعر متفق عليه (بعملة محددة)، ومن مورد محدد.
--  - الدفعات على الحساب (من العميل أو للمورد)، بأي عملة، مع ربط اختياري بسيارة،
--    وتُحوَّل لعملة الرصيد المقصود بسعر صرف يُحفظ مع الدفعة.
-- آمنة للتكرار (القواعد الجديدة تُبنى من schema.sql بها مسبقًا).
SET search_path TO auction, public;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS customer_price NUMERIC(14,3);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS customer_currency CHAR(3);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS customer_assigned_at TIMESTAMPTZ;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_customer_price_ok') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicle_customer_price_ok CHECK (
      customer_price IS NULL OR (customer_id IS NOT NULL AND customer_price > 0 AND customer_currency IN ('USD','LYD','EUR')));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicles_vendor ON vehicles(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_vendor ON vehicle_costs(vendor_id) WHERE vendor_id IS NOT NULL AND voided_at IS NULL;

CREATE TABLE IF NOT EXISTS account_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type      TEXT NOT NULL CHECK (party_type IN ('CUSTOMER','VENDOR')),  -- CUSTOMER: قبض من العميل · VENDOR: دفع للمورد
  customer_id     UUID REFERENCES customers(id),
  vendor_id       UUID REFERENCES vendors(id),
  vehicle_id      UUID REFERENCES vehicles(id),                -- اختياري: الدفعة مخصصة لسيارة
  amount          NUMERIC(14,3) NOT NULL CHECK (amount > 0),   -- المبلغ المستلم/المدفوع فعلًا
  currency        CHAR(3) NOT NULL CHECK (currency IN ('USD','LYD','EUR')),
  settle_currency CHAR(3) NOT NULL CHECK (settle_currency IN ('USD','LYD','EUR')), -- الرصيد الذي تُخصم منه
  fx_rate         NUMERIC(14,6),                               -- دينار لكل وحدة أجنبية، عند اختلاف العملتين
  settle_amount   NUMERIC(14,3) NOT NULL CHECK (settle_amount > 0),
  method          payment_method NOT NULL,
  reference       TEXT,
  note            TEXT,
  paid_at         DATE NOT NULL DEFAULT current_date,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,                                  -- لا حذف فعلي: الإلغاء يُسجَّل مع السبب
  voided_by       UUID REFERENCES users(id),
  void_reason     TEXT,
  CHECK ((party_type = 'CUSTOMER') = (customer_id IS NOT NULL)),
  CHECK ((party_type = 'VENDOR') = (vendor_id IS NOT NULL)),
  CHECK (currency <> settle_currency OR (settle_amount = amount AND fx_rate IS NULL)),
  CHECK (currency = settle_currency OR (fx_rate > 0 AND 'LYD' IN (currency, settle_currency))),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_accpay_customer ON account_payments(customer_id, paid_at) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accpay_vendor ON account_payments(vendor_id, paid_at) WHERE vendor_id IS NOT NULL;
