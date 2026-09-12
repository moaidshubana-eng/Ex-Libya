-- إضافة هامش ربح/خسارة الصفقات (سعر السوق الموازي مقابل سعر البيع المقفل)،
-- وحذف علم "requiresDualApproval" — ألغيت الموافقة المزدوجة القائمة على حد
-- عام كمتطلَّب لإنشاء صفقة (تبقى مسارات approve/reject قائمة فقط لتسوية أي
-- صفقة تاريخية سبق أن دخلت PENDING_APPROVAL قبل هذا التغيير).

-- 1) إضافة العمودين بلا قيد NOT NULL مؤقتًا لتفادي فشل الإضافة على صفوف موجودة
ALTER TABLE "transactions" ADD COLUMN "parallelMarketRate" DECIMAL(18,6);
ALTER TABLE "transactions" ADD COLUMN "profitLyd" DECIMAL(18,2);

-- 2) تعبئة الصفوف التاريخية: لا هامش رُصِد وقتها، فنفترض سعرًا موازيًا مساويًا
--    لسعر القفل نفسه (هامش صفر) بدل تخمين رقم غير حقيقي.
UPDATE "transactions" SET "parallelMarketRate" = "lockedRate", "profitLyd" = 0
WHERE "parallelMarketRate" IS NULL;

-- 3) فرض القيد الآن بعد التعبئة
ALTER TABLE "transactions" ALTER COLUMN "parallelMarketRate" SET NOT NULL;
ALTER TABLE "transactions" ALTER COLUMN "profitLyd" SET NOT NULL;

-- 4) حذف عمود العلم القديم (لم يعد له معنى — الحالة PENDING_APPROVAL نفسها،
--    إن وُجدت تاريخيًا، تكفي للدلالة على أن الصفقة احتاجت موافقة مزدوجة)
ALTER TABLE "transactions" DROP COLUMN "requiresDualApproval";

-- 5) القيمة الافتراضية الجديدة لحالة الصفقة — كل صفقة جديدة تُنشأ معتمدة مباشرة
ALTER TABLE "transactions" ALTER COLUMN "status" SET DEFAULT 'APPROVED';
