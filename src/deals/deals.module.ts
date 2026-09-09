import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';

@Module({
  imports: [AuditModule, WhatsAppModule],
  controllers: [DealsController],
  providers: [DealsService],
  exports: [DealsService],
})
export class DealsModule {}
