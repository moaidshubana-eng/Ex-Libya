-- 1) أرقام مسلسلة للإيصالات: قبض من العميل RC-YYYY-00001، وسند صرف للمورد PV-YYYY-00001
-- 2) مصاريف الشركة العامة (إيجار، رواتب…) غير المرتبطة بسيارة
SET search_path TO auction, public;

CREATE SEQUENCE IF NOT EXISTS receipt_seq;
CREATE SEQUENCE IF NOT EXISTS voucher_seq;
CREATE SEQUENCE IF NOT EXISTS expense_seq;
ALTER TABLE account_payments ADD COLUMN IF NOT EXISTS receipt_no TEXT;
-- ترقيم الدفعات الموجودة بترتيب تسجيلها
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id, party_type, paid_at FROM account_payments WHERE receipt_no IS NULL ORDER BY created_at, id LOOP
    UPDATE account_payments SET receipt_no =
      CASE WHEN r.party_type = 'CUSTOMER' THEN 'RC-' || to_char(r.paid_at, 'YYYY') || '-' || lpad(nextval('receipt_seq')::text, 5, '0')
           ELSE 'PV-' || to_char(r.paid_at, 'YYYY') || '-' || lpad(nextval('voucher_seq')::text, 5, '0') END
     WHERE id = r.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_payments_receipt ON account_payments(receipt_no);

CREATE TABLE IF NOT EXISTS company_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_no      TEXT NOT NULL UNIQUE,                 -- EX-2026-00001
  category        TEXT NOT NULL CHECK (category IN ('RENT','SALARIES','UTILITIES','FUEL_TRANSPORT','MARKETING','GOVERNMENT_FEES','OFFICE','MAINTENANCE','BANK_FEES','OTHER')),
  description     TEXT NOT NULL,
  amount          NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL CHECK (currency IN ('USD','LYD','EUR')),
  fx_rate_to_lyd  NUMERIC(14,6) NOT NULL CHECK (fx_rate_to_lyd > 0),  -- لقطة سعر الصرف يوم المصروف
  amount_lyd      NUMERIC(14,3) GENERATED ALWAYS AS (round(amount * fx_rate_to_lyd, 3)) STORED,
  expense_date    DATE NOT NULL,
  method          payment_method NOT NULL DEFAULT 'CASH',
  reference       TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,                           -- لا حذف فعلي
  voided_by       UUID REFERENCES users(id),
  void_reason     TEXT,
  CHECK (currency <> 'LYD' OR fx_rate_to_lyd = 1),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON company_expenses(expense_date) WHERE voided_at IS NULL;
