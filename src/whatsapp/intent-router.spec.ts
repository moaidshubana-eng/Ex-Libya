import { MessageIntent } from '@prisma/client';
import { classifyIntent } from './intent-router';

describe('classifyIntent', () => {
  it.each(['السعر', 'كم سعر الدولار اليوم؟', 'الاسعار', 'اسعار العملات'])(
    '"%s" → RATE_INQUIRY',
    (text) => {
      expect(classifyIntent(text)).toBe(MessageIntent.RATE_INQUIRY);
    },
  );

  it.each(['أريد التحدث مع موظف', 'لدي شكوى بخصوص صفقة أمس', 'مرحبا'])(
    '"%s" → HUMAN_HANDOFF',
    (text) => {
      expect(classifyIntent(text)).toBe(MessageIntent.HUMAN_HANDOFF);
    },
  );

  it('نص فارغ → OTHER', () => {
    expect(classifyIntent('   ')).toBe(MessageIntent.OTHER);
  });
});
