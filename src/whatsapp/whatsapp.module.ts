import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { MetaCloudApiProvider } from './provider/meta-cloud-api.provider';
import { NullWhatsAppProvider } from './provider/null.provider';
import { WHATSAPP_PROVIDER } from './provider/whatsapp-provider.interface';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [AuditModule, ConfigModule],
  controllers: [WhatsAppController],
  providers: [
    MetaCloudApiProvider,
    NullWhatsAppProvider,
    {
      provide: WHATSAPP_PROVIDER,
      inject: [ConfigService, MetaCloudApiProvider, NullWhatsAppProvider],
      // يُستخدم موفّر Meta الفعلي فقط عند ضبط بيانات اعتماد كاملة؛ غيابها
      // (بيئة تطوير أو اختبار) يفعّل الموفّر الوهمي تلقائيًا دون أي خطأ إعداد.
      useFactory: (
        config: ConfigService,
        meta: MetaCloudApiProvider,
        nullProvider: NullWhatsAppProvider,
      ) => {
        const configured =
          config.get<string>('whatsapp.accessToken') &&
          config.get<string>('whatsapp.phoneNumberId');
        return configured ? meta : nullProvider;
      },
    },
    WhatsAppService,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
