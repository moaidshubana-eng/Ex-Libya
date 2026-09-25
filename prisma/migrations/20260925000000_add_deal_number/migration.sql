-- رقم معاملة تسلسلي قابل للقراءة لكل صفقة — مستقل عن id (UUID)، لعرضه ومتابعته
-- في الواجهة بسهولة. تُعبَّأ الصفقات الموجودة مسبقًا بترتيب الإنشاء (الأقدم
-- يحصل على الرقم الأصغر)، ثم يُنشأ تسلسل مستقل يبدأ بعد آخر رقم مُستخدَم
-- ليكون افتراضي العمود عند كل إدخال قادم.

ALTER TABLE "transactions" ADD COLUMN "dealNumber" INTEGER;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn
  FROM "transactions"
)
UPDATE "transactions" t
SET "dealNumber" = 100000 + numbered.rn
FROM numbered
WHERE t."id" = numbered."id";

CREATE SEQUENCE "transactions_dealNumber_seq" OWNED BY "transactions"."dealNumber";
SELECT setval('"transactions_dealNumber_seq"', COALESCE((SELECT MAX("dealNumber") FROM "transactions"), 100000), true);

ALTER TABLE "transactions" ALTER COLUMN "dealNumber" SET DEFAULT nextval('"transactions_dealNumber_seq"');
ALTER TABLE "transactions" ALTER COLUMN "dealNumber" SET NOT NULL;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dealNumber_key" UNIQUE ("dealNumber");
