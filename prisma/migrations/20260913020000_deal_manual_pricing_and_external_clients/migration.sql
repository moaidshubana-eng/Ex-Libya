-- سعر الصفقة (lockedRate) وسعر السوق الموازي (parallelMarketRate) كلاهما يدوي
-- بالكامل عند الإنشاء الآن — لا تغيير على العمودين نفسيهما (النوع/الاسم)،
-- التغيير في من يملأ lockedRate: الموظف يدويًا لا آخر سعر منشور تلقائيًا.

-- دعم تنفيذ الصفقات لزبائن خارجيين غير مسجَّلين في النظام، على غرار وحدة
-- الحوالات (customerType INTERNAL/EXTERNAL) تمامًا — لا حاجة لتسجيل عميل كامل
-- لصفقة عابرة واحدة.

CREATE TYPE "DealCustomerType" AS ENUM ('INTERNAL', 'EXTERNAL');

ALTER TABLE "transactions" ADD COLUMN "customerType" "DealCustomerType" NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "transactions" ADD COLUMN "externalCustomerName" TEXT;
ALTER TABLE "transactions" ADD COLUMN "externalCustomerPhone" TEXT;

-- عميل داخلي إلزامي حاليًا (كل الصفقات التاريخية داخلية بالفعل، فالقيم
-- الموجودة تبقى كما هي) — يصبح اختياريًا ليسمح بصفقة خارجية بلا clientId.
ALTER TABLE "transactions" ALTER COLUMN "clientId" DROP NOT NULL;
