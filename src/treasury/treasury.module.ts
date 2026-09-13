import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { BanksController } from './banks.controller';
import { BanksService } from './banks.service';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

@Module({
  imports: [AuditModule, WhatsAppModule],
  controllers: [TreasuryController, BanksController],
  providers: [TreasuryService, BanksService],
  exports: [TreasuryService, BanksService],
})
export class TreasuryModule {}
