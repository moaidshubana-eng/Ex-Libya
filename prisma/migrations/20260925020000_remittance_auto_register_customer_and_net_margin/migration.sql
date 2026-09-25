-- إلغاء إدخال اسم الطرف الآخر والقيمة الأساسية للحوالة صراحةً — العمودان
-- يبقيان لحفظ بيانات الحوالات التاريخية فقط.
ALTER TABLE "remittances" ALTER COLUMN "counterpartyName" DROP NOT NULL;
ALTER TABLE "remittances" ALTER COLUMN "principalAmount" DROP NOT NULL;
