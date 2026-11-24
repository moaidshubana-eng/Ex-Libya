-- الحسابات المصرفية للشركة: إيداع وصرف وسحب بكشف ورصيد. الصرف يُسجَّل مصروفًا عامًا، وسداد مصروف مسجل لا يكرره؛ والإيداع ليس إيرادًا.
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,                          -- اسم الحساب كما يظهر في الكشف
  bank_name    TEXT,
  account_no   TEXT,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          BIGSERIAL NOT NULL UNIQUE,              -- ترتيب التسجيل: الكشف يُعرض به
  account_id   UUID NOT NULL REFERENCES bank_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('DEPOSIT','EXPENSE','SETTLE','WITHDRAW')),  -- إيداع / صرف جديد / سداد مصروف مسجل من قبل / سحب نقدي
  entry_date   DATE NOT NULL,
  description  TEXT NOT NULL,
  amount       NUMERIC(14,3) NOT NULL CHECK (amount > 0),  -- بالدينار
  expense_id   UUID REFERENCES company_expenses(id),
  reimbursed   BOOLEAN NOT NULL DEFAULT FALSE,         -- هذه الحركة هي التي ردّت المبلغ لمن دفعه (فإلغاؤها يعيده مستحقًا)
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at    TIMESTAMPTZ,                            -- لا حذف فعلي
  voided_by    UUID REFERENCES users(id),
  void_reason  TEXT,
  CHECK ((kind IN ('EXPENSE','SETTLE')) = (expense_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_bank_entries ON bank_entries(account_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_expense ON bank_entries(expense_id) WHERE expense_id IS NOT NULL AND voided_at IS NULL;  -- المصروف يُدفع من الحساب مرة واحدة
