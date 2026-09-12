-- إلغاء "السعر الرسمي" وتوحيد أسعار الصرف في حقل واحد (rate)
-- يُعتمَد السعر الموازي (parallelRate) القائم كأساس للسعر الوحيد المتبقي،
-- لأنه كان بالفعل السعر التجاري الفعلي المستخدم في تسعير الصفقات.

-- 1) إضافة العمود الجديد (بلا قيد NOT NULL مؤقتًا لتفادي فشل الإضافة على صفوف موجودة)
ALTER TABLE "exchange_rates" ADD COLUMN "rate" DECIMAL(18,6);

-- 2) تعبئته من parallelRate لكل الصفوف الموجودة
UPDATE "exchange_rates" SET "rate" = "parallelRate";

-- 3) فرض القيد الآن بعد التعبئة
ALTER TABLE "exchange_rates" ALTER COLUMN "rate" SET NOT NULL;

-- 4) حذف العمودين القديمين
ALTER TABLE "exchange_rates" DROP COLUMN "officialRate";
ALTER TABLE "exchange_rates" DROP COLUMN "parallelRate";

-- 5) حذف عمود rateType من الصفقات (لم يعد هناك أكثر من سعر واحد يُختار بينه)
ALTER TABLE "transactions" DROP COLUMN "rateType";

-- 6) حذف نوع التعداد RateType نفسه بعد التأكد من عدم استخدامه في أي عمود
DROP TYPE "RateType";
