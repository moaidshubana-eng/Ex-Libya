-- فواتير المصاريف (صورة أو PDF مرفقة بالمصروف)، والمصاريف التي دفعها شخص من ماله الخاص ثم تردّها له الشركة.
SET search_path TO auction, public;

ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_by TEXT;              -- فارغ = دفعتها الشركة؛ وإلا اسم من دفعها من ماله
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS reimbursed_at TIMESTAMPTZ;  -- متى ردّت الشركة المبلغ له
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS reimbursed_by UUID REFERENCES users(id);
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS reimburse_note TEXT;
CREATE INDEX IF NOT EXISTS idx_expenses_owed ON company_expenses(paid_by) WHERE paid_by IS NOT NULL AND reimbursed_at IS NULL AND voided_at IS NULL;

CREATE TABLE IF NOT EXISTS expense_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id   UUID NOT NULL REFERENCES company_expenses(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  bytes        INT NOT NULL,
  content      BYTEA NOT NULL,                          -- في القاعدة: الاستضافة قد لا تملك قرصًا دائمًا
  uploaded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_attachments ON expense_attachments(expense_id);
