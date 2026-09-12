-- إلغاء إلزامية الحد الأدنى وسقف التعرّض لخطوط الخزينة — كلاهما اختياري الآن.
-- تُلغى القيم الحالية المضبوطة مسبقًا (تحويلها إلى NULL) بما أن هذا إعداد
-- تشغيلي حالي لا سجل تاريخي، وليس دفتر حركات (خلافًا لـ TreasuryMovement).

ALTER TABLE "treasury_positions" ALTER COLUMN "minThreshold" DROP NOT NULL;
ALTER TABLE "treasury_positions" ALTER COLUMN "minThreshold" DROP DEFAULT;
ALTER TABLE "treasury_positions" ALTER COLUMN "maxExposure" DROP NOT NULL;

UPDATE "treasury_positions" SET "minThreshold" = NULL, "maxExposure" = NULL;
