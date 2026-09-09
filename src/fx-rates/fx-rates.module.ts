import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { FxRatesController } from './fx-rates.controller';
import { FxRatesService } from './fx-rates.service';

@Module({
  imports: [AuditModule, WhatsAppModule],
  controllers: [FxRatesController],
  providers: [FxRatesService],
  exports: [FxRatesService],
})
export class FxRatesModule {}
