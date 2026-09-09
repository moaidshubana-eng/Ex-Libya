import { MessageIntent } from '@prisma/client';

const RATE_INQUIRY_KEYWORDS = ['سعر', 'الاسعار', 'الأسعار', 'اسعار', 'كم الدولار', 'كم اليورو'];

/**
 * توجيه نوايا بسيط قائم على كلمات مفتاحية — كافٍ للسيناريوهين الآليين
 * المدعومين حاليًا (استفسار سعر، وتحويل لموظف بشري لأي شيء آخر).
 * راجع الرد الآلي في message-composer.ts.
 */
export function classifyIntent(rawText: string): MessageIntent {
  const text = rawText.trim();
  if (!text) return MessageIntent.OTHER;

  const isRateInquiry = RATE_INQUIRY_KEYWORDS.some((keyword) => text.includes(keyword));
  return isRateInquiry ? MessageIntent.RATE_INQUIRY : MessageIntent.HUMAN_HANDOFF;
}
