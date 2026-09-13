-- ربط رسائل واتساب بحركة رصيد العميل التي أطلقتها — يتيح للوحة التحكم عرض
-- حالة إشعار الواتساب (أُرسل/فشل) بجانب كل حركة في سجل حركات الرصيد.

ALTER TABLE "whatsapp_messages" ADD COLUMN "relatedClientBalanceMovementId" TEXT;

ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_relatedClientBalanceMovementId_fkey"
  FOREIGN KEY ("relatedClientBalanceMovementId") REFERENCES "client_balance_movements"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
