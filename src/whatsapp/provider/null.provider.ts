import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SendResult, WhatsAppProvider } from './whatsapp-provider.interface';

/**
 * مزوّد وهمي يُستخدم عند عدم ضبط بيانات اعتماد Meta (بيئة تطوير محلية أو
 * اختبار) — يسجّل الرسالة في السجلات دون إرسالها فعليًا، فتبقى بقية المنظومة
 * (توجيه النوايا، سجل الرسائل، تنبيهات الحدود...) قابلة للتشغيل والتحقق منها
 * كاملةً دون بيانات اعتماد حقيقية من Meta.
 */
@Injectable()
export class NullWhatsAppProvider implements WhatsAppProvider {
  private readonly logger = new Logger(NullWhatsAppProvider.name);

  async sendText(to: string, body: string): Promise<SendResult> {
    this.logger.warn(`[محاكاة] رسالة نصية إلى ${to}: ${body}`);
    return { providerMessageId: `simulated-${randomUUID()}` };
  }

  async sendTemplate(
    to: string,
    templateName: string,
    language: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    this.logger.warn(
      `[محاكاة] قالب "${templateName}" (${language}) إلى ${to} — المعاملات: ${bodyParams.join(', ')}`,
    );
    return { providerMessageId: `simulated-${randomUUID()}` };
  }
}
