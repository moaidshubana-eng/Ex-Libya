-- بوابة العملاء: حساب دخول لكل عميل (رقم الهاتف + كلمة سر يضعها الموظف)، بجلسات منفصلة تمامًا عن جلسات الموظفين،
-- وكود تتبّع عشوائي لكل سيارة يفتح صفحة تتبّع عامة بلا دخول (بلا مبالغ).
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS portal_accounts (
  customer_id    UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,
  must_change    BOOLEAN NOT NULL DEFAULT TRUE,     -- كلمة سر مؤقتة من الموظف: يغيّرها العميل عند أول دخول
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                -- SHA-256 للرمز (الرمز نفسه لا يُخزَّن)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  ip           INET,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id) WHERE revoked_at IS NULL;

-- 12 خانة سداسية عشرية عشوائية (48 بت)؛ مع حد المعدل يستحيل تخمينها
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS track_code TEXT;
UPDATE vehicles SET track_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) WHERE track_code IS NULL;
ALTER TABLE vehicles ALTER COLUMN track_code SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
ALTER TABLE vehicles ALTER COLUMN track_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_track_code ON vehicles(track_code);
