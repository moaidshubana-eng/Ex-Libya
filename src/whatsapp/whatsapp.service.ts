import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DealDirection,
  MessageDirection,
  MessageIntent,
  MessageKind,
  MessageStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListMessagesQuery } from './dto/list-messages.query';
import { extractInboundTextMessages } from './inbound-payload';
import { classifyIntent } from './intent-router';
import {
  composeDealConfirmationLogBody,
  composeDealConfirmationParams,
  composeHumanHandoffAck,
  composeLimitAlertLogBody,
  composeLimitAlertParams,
  composeRateInquiryReply,
  composeRateUpdateLogBody,
  composeRateUpdateParams,
  LimitAlertInput,
  RateSummary,
} from './message-composer';
import { toDigitsOnly, toE164 } from './phone';
import { WHATSAPP_PROVIDER, WhatsAppProvider } from './provider/whatsapp-provider.interface';
import { WHATSAPP_TEMPLATES, WhatsAppTemplateKey } from './templates';
import { verifyMetaSignature } from './verify-signature';

interface DealForConfirmation {
  id: string;
  direction: DealDirection;
  amount: string | number;
  lockedRate: string | number;
  currency: { code: string };
  client: { id: string; fullName: string; phone: string };
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly verifyToken: string;
  private readonly appSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    config: ConfigService,
  ) {
    this.verifyToken = config.get<string>('whatsapp.verifyToken')!;
    this.appSecret = config.get<string>('whatsapp.appSecret')!;
  }

  // ---- ربط الرابط الخلفي (Webhook) ----

  /** يُستدعى من GET /webhooks/whatsapp أثناء ربط الرابط الخلفي في Meta Business Manager لأول مرة. */
  verifyWebhookChallenge(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ) {
    if (mode !== 'subscribe' || token !== this.verifyToken || !challenge) {
      throw new ForbiddenException('فشل التحقق من رابط استقبال واتساب الخلفي');
    }
    return challenge;
  }

  /** يُستدعى من POST /webhooks/whatsapp لكل حمولة واردة من Meta. */
  async handleWebhookPayload(rawBody: Buffer, signatureHeader: string | undefined) {
    if (this.appSecret) {
      if (!verifyMetaSignature(rawBody, signatureHeader, this.appSecret)) {
        throw new ForbiddenException('توقيع Webhook غير صالح');
      }
    } else {
      this.logger.warn(
        'WHATSAPP_APP_SECRET غير مضبوط — تم تجاوز التحقق من التوقيع (بيئة تطوير فقط)',
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return; // حمولة غير صالحة — نتجاهلها بصمت بدل كسر الرابط الخلفي لدى Meta
    }

    for (const message of extractInboundTextMessages(payload)) {
      await this.handleInboundText(message.from, message.text, message.waMessageId);
    }
  }

  private async handleInboundText(fromDigits: string, text: string, _waMessageId: string) {
    const phone = toE164(fromDigits);
    const client = await this.prisma.client.findUnique({ where: { phone } });
    const intent = classifyIntent(text);

    await this.prisma.whatsAppMessage.create({
      data: {
        direction: MessageDirection.INBOUND,
        kind: MessageKind.FREE_TEXT,
        intent,
        waPhoneNumber: fromDigits,
        clientId: client?.id,
        body: text,
        status: MessageStatus.RECEIVED,
      },
    });

    // الرد على رسالة واردة يقع دومًا داخل نافذة الخدمة المفتوحة للتو — نص حر مسموح.
    const replyBody =
      intent === MessageIntent.RATE_INQUIRY
        ? composeRateInquiryReply(await this.getLatestRatesForReply())
        : composeHumanHandoffAck();

    await this.sendFreeTextSafely({ to: fromDigits, clientId: client?.id, body: replyBody });
  }

  private async getLatestRatesForReply(): Promise<RateSummary[]> {
    const currencies = await this.prisma.currency.findMany({
      where: { isActive: true, code: { not: 'LYD' } },
      orderBy: { code: 'asc' },
    });
    const rates = await Promise.all(
      currencies.map(async (currency) => {
        const rate = await this.prisma.exchangeRate.findFirst({
          where: { currencyId: currency.id },
          orderBy: { createdAt: 'desc' },
        });
        if (!rate) return null;
        return {
          code: currency.code,
          name: currency.name,
          officialRate: rate.officialRate.toFixed(4),
          parallelRate: rate.parallelRate.toFixed(4),
        };
      }),
    );
    return rates.filter((r): r is RateSummary => r !== null);
  }

  // ---- رسائل صادرة تبدأها الشركة (قوالب معتمدة إلزامية) ----

  async sendDealConfirmation(deal: DealForConfirmation) {
    const params = composeDealConfirmationParams({
      clientName: deal.client.fullName,
      direction: deal.direction,
      amount: String(deal.amount),
      currencyCode: deal.currency.code,
      lockedRate: String(deal.lockedRate),
    });
    const logBody = composeDealConfirmationLogBody({
      clientName: deal.client.fullName,
      direction: deal.direction,
      amount: String(deal.amount),
      currencyCode: deal.currency.code,
      lockedRate: String(deal.lockedRate),
    });

    await this.sendTemplateSafely({
      to: toDigitsOnly(deal.client.phone),
      clientId: deal.client.id,
      templateKey: 'DEAL_CONFIRMATION',
      templateParams: params,
      logBody,
      relatedDealId: deal.id,
    });
  }

  async sendLimitAlert(
    client: { id: string; fullName: string; phone: string },
    input: Omit<LimitAlertInput, 'clientName'>,
  ) {
    const full: LimitAlertInput = { clientName: client.fullName, ...input };
    await this.sendTemplateSafely({
      to: toDigitsOnly(client.phone),
      clientId: client.id,
      templateKey: 'LIMIT_ALERT',
      templateParams: composeLimitAlertParams(full),
      logBody: composeLimitAlertLogBody(full),
    });
  }

  /** يبثّ تحديث سعر لكل عميل مفعّل ومكتمل KYC وافق صراحة (whatsappOptIn) على تحديثات واتساب الجماعية. */
  async broadcastRateUpdate(currencyCode: string, triggeredByActorId: string) {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive)
      throw new NotFoundException(`العملة ${currencyCode} غير مسجّلة أو غير مفعّلة`);

    const rate = await this.prisma.exchangeRate.findFirst({
      where: { currencyId: currency.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!rate) throw new NotFoundException(`لا يوجد سعر منشور لعملة ${currency.code} بعد`);

    const rateSummary: RateSummary = {
      code: currency.code,
      name: currency.name,
      officialRate: rate.officialRate.toFixed(4),
      parallelRate: rate.parallelRate.toFixed(4),
    };
    const templateParams = composeRateUpdateParams(rateSummary);
    const logBody = composeRateUpdateLogBody(rateSummary);

    const subscribers = await this.prisma.client.findMany({
      where: { whatsappOptIn: true, isActive: true, kycStatus: 'VERIFIED' },
      select: { id: true, phone: true },
    });

    let sent = 0;
    let failed = 0;
    for (const subscriber of subscribers) {
      const outcome = await this.sendTemplateSafely({
        to: toDigitsOnly(subscriber.phone),
        clientId: subscriber.id,
        templateKey: 'RATE_UPDATE',
        templateParams,
        logBody,
      });
      if (outcome === MessageStatus.SENT) sent += 1;
      else failed += 1;
    }

    await this.audit.record({
      entityType: 'WhatsAppBroadcast',
      entityId: currency.id,
      action: 'BROADCAST_RATE_UPDATE',
      actorId: triggeredByActorId,
      after: { currency: currency.code, recipients: subscribers.length, sent, failed },
    });

    return { currency: currency.code, recipients: subscribers.length, sent, failed };
  }

  // ---- الاستعلام (لوحة مراجعة سجل الرسائل) ----

  async findMessages(query: ListMessagesQuery) {
    const where = query.clientId ? { clientId: query.clientId } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.whatsAppMessage.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ---- إرسال آمن: لا يرمي أبدًا — رسالة فاشلة تُسجَّل ولا تكسر العملية المالية المرتبطة بها ----

  private async sendFreeTextSafely(input: { to: string; clientId?: string; body: string }) {
    try {
      const result = await this.provider.sendText(input.to, input.body);
      await this.prisma.whatsAppMessage.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          kind: MessageKind.FREE_TEXT,
          waPhoneNumber: input.to,
          clientId: input.clientId,
          body: input.body,
          status: MessageStatus.SENT,
          providerMessageId: result.providerMessageId,
        },
      });
      return MessageStatus.SENT;
    } catch (error) {
      this.logger.error(`فشل إرسال رد نصي لواتساب ${input.to}`, error as Error);
      await this.prisma.whatsAppMessage.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          kind: MessageKind.FREE_TEXT,
          waPhoneNumber: input.to,
          clientId: input.clientId,
          body: input.body,
          status: MessageStatus.FAILED,
          errorMessage: (error as Error).message,
        },
      });
      return MessageStatus.FAILED;
    }
  }

  private async sendTemplateSafely(input: {
    to: string;
    clientId?: string;
    templateKey: WhatsAppTemplateKey;
    templateParams: readonly string[];
    logBody: string;
    relatedDealId?: string;
  }) {
    const template = WHATSAPP_TEMPLATES[input.templateKey];
    try {
      const result = await this.provider.sendTemplate(input.to, template.name, template.language, [
        ...input.templateParams,
      ]);
      await this.prisma.whatsAppMessage.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          kind: MessageKind.TEMPLATE,
          waPhoneNumber: input.to,
          clientId: input.clientId,
          templateName: template.name,
          body: input.logBody,
          status: MessageStatus.SENT,
          providerMessageId: result.providerMessageId,
          relatedDealId: input.relatedDealId,
        },
      });
      return MessageStatus.SENT;
    } catch (error) {
      this.logger.error(`فشل إرسال قالب "${template.name}" لواتساب ${input.to}`, error as Error);
      await this.prisma.whatsAppMessage.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          kind: MessageKind.TEMPLATE,
          waPhoneNumber: input.to,
          clientId: input.clientId,
          templateName: template.name,
          body: input.logBody,
          status: MessageStatus.FAILED,
          errorMessage: (error as Error).message,
          relatedDealId: input.relatedDealId,
        },
      });
      return MessageStatus.FAILED;
    }
  }
}
