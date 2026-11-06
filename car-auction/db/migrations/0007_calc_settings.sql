-- إعدادات الحاسبة العامة (/calc): صف واحد يغيّره المدير ويقرأه كل زائر.
SET search_path TO auction, public;

CREATE TABLE IF NOT EXISTS calc_settings (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- يضمن صفًا واحدًا فقط
  data        JSONB NOT NULL,                                -- سعر الصرف، فرق الحوالة، الواير، هامش النقل، أسعار الشحن
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
