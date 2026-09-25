-- ربط رسائل واتساب بالحوالة التي أطلقت الإشعار (تم السحب) — يتيح للوحة
-- التحكم عرض حالة إشعار الواتساب (أُرسل/فشل) بجانب كل حوالة.

ALTER TABLE "whatsapp_messages" ADD COLUMN "relatedRemittanceId" TEXT;

ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_relatedRemittanceId_fkey"
  FOREIGN KEY ("relatedRemittanceId") REFERENCES "remittances"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
