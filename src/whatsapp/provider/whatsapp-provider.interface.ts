export interface SendResult {
  providerMessageId?: string;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

/** فاصل بين منطق النظام وأي مزوّد فعلي لواتساب — يسمح باستبدال Meta لاحقًا أو باختبار الخدمة دون شبكة. */
export interface WhatsAppProvider {
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(
    to: string,
    templateName: string,
    language: string,
    bodyParams: string[],
  ): Promise<SendResult>;
}
