-- صور السيارات المرفوعة يدويًا تُحفظ داخل قاعدة البيانات (الاستضافة المجانية بلا قرص دائم).
-- آمنة للتكرار: لا تفعل شيئًا إن كانت الأعمدة موجودة (القواعد الجديدة تُبنى من schema.sql بها مسبقًا).
ALTER TABLE auction.vehicle_images ADD COLUMN IF NOT EXISTS content BYTEA;
ALTER TABLE auction.vehicle_images ADD COLUMN IF NOT EXISTS mime TEXT;
