import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { PublishRateDto } from './dto/publish-rate.dto';
import { assessRateChange } from './rate-deviation';

@Injectable()
export class FxRatesService {
  private readonly logger = new Logger(FxRatesService.name);
  private readonly maxDeviationPercent: number;
  private readonly broadcastDeviationPercent: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly whatsApp: WhatsAppService,
    config: ConfigService,
  ) {
    this.maxDeviationPercent = config.get<number>('fx.maxDeviationPercent')!;
    this.broadcastDeviationPercent = config.get<number>('whatsapp.broadcastDeviationPercent')!;
  }

  private async getCurrencyOrThrow(currencyCode: string) {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${currencyCode} غير مسجّلة أو غير مفعّلة`);
    }
    return currency;
  }

  private async getLatestRate(currencyId: string) {
    return this.prisma.exchangeRate.findFirst({
      where: { currencyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** أحدث سعر لكل عملة مفعّلة — ما تعرضه لوحة التحكم وبوابة واتساب. */
  async getLatestRates() {
    const currencies = await this.prisma.currency.findMany({ where: { isActive: true } });
    const latestRates = await Promise.all(
      currencies.map(async (currency) => ({
        currency: { code: currency.code, name: currency.name },
        rate: await this.getLatestRate(currency.id),
      })),
    );
    return latestRates.filter((entry) => entry.rate !== null);
  }

  async getHistory(currencyCode: string, limit = 50) {
    const currency = await this.getCurrencyOrThrow(currencyCode);
    return this.prisma.exchangeRate.findMany({
      where: { currencyId: currency.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { publishedBy: { select: { id: true, fullName: true, role: true } } },
    });
  }

  /**
   * ينشر سعرًا جديدًا لعملة بعد تمريره عبر قاطع الدائرة (assessRateChange).
   * يرفض أي تغيّر يتجاوز نسبة الانحراف المسموح بها ما لم يُرفَق بسبب تجاوز
   * موثّق — وعندها يُسجَّل السعر كـ "تجاوز يدوي" مع صاحبه وسببه في سجل التدقيق.
   */
  async publish(currencyCode: string, dto: PublishRateDto, actor: AuthenticatedUser) {
    const currency = await this.getCurrencyOrThrow(currencyCode);
    const previous = await this.getLatestRate(currency.id);

    const assessment = assessRateChange({
      previousRate: previous?.rate ?? null,
      nextRate: dto.rate,
      maxDeviationPercent: this.maxDeviationPercent,
      hasOverrideReason: Boolean(dto.overrideReason),
    });

    if (!assessment.accepted) {
      throw new BadRequestException({
        message: `تغيّر السعر يتجاوز الحد الأقصى للانحراف المسموح به (${this.maxDeviationPercent}%). أرفق سبب تجاوز موثّق (overrideReason) لتأكيد النشر.`,
        deviationPercent: assessment.deviationPercent.toFixed(2),
        maxDeviationPercent: this.maxDeviationPercent,
      });
    }

    const source: RateSource = assessment.resolvedIsOverride
      ? RateSource.OVERRIDE
      : RateSource.MANUAL;

    const created = await this.prisma.exchangeRate.create({
      data: {
        currencyId: currency.id,
        rate: dto.rate,
        source,
        isOverride: assessment.resolvedIsOverride,
        overrideReason: assessment.resolvedIsOverride ? dto.overrideReason : null,
        publishedById: actor.id,
      },
    });

    await this.audit.record({
      entityType: 'ExchangeRate',
      entityId: created.id,
      action: assessment.resolvedIsOverride ? 'PUBLISH_RATE_OVERRIDE' : 'PUBLISH_RATE',
      actorId: actor.id,
      before: previous ? { rate: previous.rate } : null,
      after: {
        rate: created.rate,
        deviationPercent: assessment.deviationPercent.toFixed(2),
        overrideReason: created.overrideReason,
      },
    });

    // بثّ اختياري للمشتركين — لا يجوز أبدًا أن يفشل نشر السعر نفسه بسبب عطل في واتساب.
    if (assessment.deviationPercent.greaterThanOrEqualTo(this.broadcastDeviationPercent)) {
      try {
        await this.whatsApp.broadcastRateUpdate(currency.code, actor.id);
      } catch (error) {
        this.logger.error(`فشل بثّ تحديث سعر ${currency.code} عبر واتساب`, error as Error);
      }
    }

    return created;
  }
}
