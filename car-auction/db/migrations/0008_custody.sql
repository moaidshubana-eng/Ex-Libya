-- العُهد النقدية: مبلغ يستلمه شخص من الخزينة ويصرف منه، بكشف يبيّن كل حركة والرصيد بعدها.
-- الصرف من العهدة يُسجَّل أيضًا مصروفًا عامًا (company_expenses) فيدخل في الربح الشهري؛ الاستلام والإرجاع لا.
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS custodies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_name  TEXT NOT NULL,                          -- صاحب العهدة (ليس بالضرورة مستخدمًا في المنظومة)
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          BIGSERIAL NOT NULL UNIQUE,              -- ترتيب التسجيل: الكشف يُعرض بهذا الترتيب مثل دفتر العهدة
  custody_id   UUID NOT NULL REFERENCES custodies(id),
  kind         TEXT NOT NULL CHECK (kind IN ('RECEIPT','EXPENSE','RETURN')),  -- استلام من الخزينة / صرف / إرجاع للخزينة
  entry_date   DATE NOT NULL,
  description  TEXT NOT NULL,
  amount       NUMERIC(14,3) NOT NULL CHECK (amount > 0),  -- بالدينار
  expense_id   UUID REFERENCES company_expenses(id),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at    TIMESTAMPTZ,                            -- لا حذف فعلي
  voided_by    UUID REFERENCES users(id),
  void_reason  TEXT,
  CHECK ((kind = 'EXPENSE') = (expense_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_custody_entries ON custody_entries(custody_id, seq);
