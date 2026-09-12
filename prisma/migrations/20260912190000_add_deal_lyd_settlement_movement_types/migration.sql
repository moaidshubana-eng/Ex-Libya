-- إصلاح خطأ: تنفيذ صفقة صرف كان يحرّك رصيد خزينة العملة الأجنبية فقط
-- (TRADE_BUY/TRADE_SELL) دون أي أثر على رصيد خزينة الدينار الليبي — رغم أن
-- الشركة تدفع/تحصّل دينارًا فعليًا مقابل كل صفقة. نضيف نوعي حركة جديدين
-- يمثّلان الطرف المقابل بالدينار لكل صفقة، تُسجَّل حركة مستقلة بهما ضمن نفس
-- معاملة التنفيذ (DealsService.execute) دون المساس بأي حركة تاريخية موجودة.

ALTER TYPE "MovementType" ADD VALUE 'TRADE_BUY_SETTLEMENT';
ALTER TYPE "MovementType" ADD VALUE 'TRADE_SELL_SETTLEMENT';
