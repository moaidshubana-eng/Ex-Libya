export interface InboundTextMessage {
  from: string; // رقم واتساب المرسل بالصيغة الدولية بلا "+"
  text: string;
  waMessageId: string;
}

/**
 * يستخرج رسائل واتساب النصية من حمولة Webhook الخام (Meta Cloud API).
 * يتجاهل بصمت أي شيء ليس رسالة نصية واردة — تحديثات حالة التسليم (statuses)
 * وأنواع الوسائط الأخرى (صور، صوت...) خارج نطاق هذا الإصدار عمدًا.
 * دالة نقية ومتسامحة: أي شكل غير متوقع يُنتج مصفوفة فارغة بدل رمي استثناء،
 * لأن Meta قد يرسل أشكال حمولات متعددة على نفس الرابط الخلفي.
 */
export function extractInboundTextMessages(payload: unknown): InboundTextMessage[] {
  const messages: InboundTextMessage[] = [];

  const entries = asArray((payload as any)?.entry);
  for (const entry of entries) {
    const changes = asArray(entry?.changes);
    for (const change of changes) {
      const rawMessages = asArray(change?.value?.messages);
      for (const raw of rawMessages) {
        if (
          raw?.type === 'text' &&
          typeof raw?.text?.body === 'string' &&
          typeof raw?.from === 'string'
        ) {
          messages.push({ from: raw.from, text: raw.text.body, waMessageId: String(raw.id ?? '') });
        }
      }
    }
  }

  return messages;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}
