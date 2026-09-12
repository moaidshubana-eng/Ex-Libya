import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RemittancesController } from './remittances.controller';
import { RemittancesService } from './remittances.service';

@Module({
  imports: [AuditModule],
  controllers: [RemittancesController],
  providers: [RemittancesService],
  exports: [RemittancesService],
})
export class RemittancesModule {}
