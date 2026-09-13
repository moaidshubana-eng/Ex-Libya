import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [AuditModule, WhatsAppModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
