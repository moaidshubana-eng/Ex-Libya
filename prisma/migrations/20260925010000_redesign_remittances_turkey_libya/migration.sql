-- إعادة تصميم وحدة الحوالات لتدفق ثابت واحد (استلام في تركيا ← تسليم في
-- ليبيا)، دورة حياة status ثلاثية تحل محل isVoided، وبدل تركيا اختياري بالدينار.

-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('PENDING', 'WITHDRAWN', 'REJECTED');

-- الاتجاه لم يعد يُطلَب لأي حوالة جديدة — يبقى العمود اختياريًا لحفظ قيمة
-- الحوالات التاريخية فقط.
ALTER TABLE "remittances" ALTER COLUMN "direction" DROP NOT NULL;

-- إعادة تسمية اقتصاديات الحوالة لتعكس التدفق الجديد (استلام تركيا/تسليم ليبيا)
ALTER TABLE "remittances" RENAME COLUMN "cost" TO "turkeyReceiptAmount";
ALTER TABLE "remittances" RENAME COLUMN "saleValue" TO "libyaDeliveryAmount";

-- بدل تركيا: هامش إضافي يدوي اختياري بالدينار الليبي — منفصل عن profit (بالدولار)
ALTER TABLE "remittances" ADD COLUMN "turkeyAllowanceLyd" DECIMAL(18,2);

-- استبدال isVoided/voidReason/voidedById/voidedAt بدورة حياة status ثلاثية —
-- الحوالات القديمة غير الملغاة (isVoided = false) تُعامَل كمكتملة (WITHDRAWN،
-- فقد كانت سُجِّلت فعليًا كحوالات منفَّذة تمامًا)، والملغاة (isVoided = true)
-- تُعامَل كمرفوضة (REJECTED) مع نقل سبب/فاعل/تاريخ الإلغاء القديم كما هو.
ALTER TABLE "remittances" ADD COLUMN "status" "RemittanceStatus";
UPDATE "remittances" SET "status" = CASE WHEN "isVoided" THEN 'REJECTED' ELSE 'WITHDRAWN' END::"RemittanceStatus";
ALTER TABLE "remittances" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "remittances" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "remittances" ADD COLUMN "statusReason" TEXT;
UPDATE "remittances" SET "statusReason" = "voidReason" WHERE "isVoided";

ALTER TABLE "remittances" ADD COLUMN "statusChangedById" TEXT;
UPDATE "remittances" SET "statusChangedById" = "voidedById" WHERE "isVoided";

ALTER TABLE "remittances" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
UPDATE "remittances" SET "statusChangedAt" = "voidedAt" WHERE "isVoided";

ALTER TABLE "remittances" DROP CONSTRAINT "remittances_voidedById_fkey";
ALTER TABLE "remittances" DROP COLUMN "isVoided";
ALTER TABLE "remittances" DROP COLUMN "voidReason";
ALTER TABLE "remittances" DROP COLUMN "voidedById";
ALTER TABLE "remittances" DROP COLUMN "voidedAt";

ALTER TABLE "remittances" ADD CONSTRAINT "remittances_statusChangedById_fkey" FOREIGN KEY ("statusChangedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- الفهرس القديم كان يجمع (provider, direction, createdAt) — الاتجاه لم يعد
-- ذا قيمة تصفية فعلية؛ يُستبدَل بـ (provider, status, createdAt).
DROP INDEX "remittances_provider_direction_createdAt_idx";
CREATE INDEX "remittances_provider_status_createdAt_idx" ON "remittances"("provider", "status", "createdAt");
