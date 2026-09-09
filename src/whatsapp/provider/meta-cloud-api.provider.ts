import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendResult, WhatsAppProvider } from './whatsapp-provider.interface';

/**
 * تنفيذ فعلي عبر WhatsApp Business Cloud API الرسمي من Meta.
 * يُستخدم عبر Node fetch المدمج (Node 18+) — لا حاجة لمكتبة HTTP خارجية.
 */
@Injectable()
export class MetaCloudApiProvider implements WhatsAppProvider {
  private readonly logger = new Logger(MetaCloudApiProvider.name);
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(config: ConfigService) {
    const apiVersion = config.get<string>('whatsapp.apiVersion')!;
    const phoneNumberId = config.get<string>('whatsapp.phoneNumberId')!;
    this.accessToken = config.get<string>('whatsapp.accessToken')!;
    this.baseUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    });
  }

  async sendTemplate(
    to: string,
    templateName: string,
    language: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: [
          { type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) },
        ],
      },
    });
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`فشل استدعاء WhatsApp Cloud API (${response.status}): ${errorBody}`);
      throw new BadGatewayException('تعذّر إرسال رسالة واتساب عبر مزوّد الخدمة');
    }

    const data: any = await response.json();
    return { providerMessageId: data?.messages?.[0]?.id };
  }
}
