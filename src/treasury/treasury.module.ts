import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

@Module({
  imports: [AuditModule, WhatsAppModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
