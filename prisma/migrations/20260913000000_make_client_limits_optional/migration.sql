-- إلغاء طلب الحد اليومي والسقف الائتماني عند تسجيل عميل جديد — لم يعودا
-- يُفحَصان على أي صفقة أصلًا (أُلغي فحص حدود العميل صراحةً)، فلا داعي لإجبار
-- إدخالهما وقت التسجيل. يبقيان قابلين للضبط لاحقًا عبر تحديث الحدود اليدوي.

ALTER TABLE "clients" ALTER COLUMN "dailyLimitUsd" DROP NOT NULL;
ALTER TABLE "clients" ALTER COLUMN "creditLimitUsd" DROP NOT NULL;
