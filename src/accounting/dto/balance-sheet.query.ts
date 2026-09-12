import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class BalanceSheetQuery {
  @ApiPropertyOptional({ description: 'لحظة إعداد القائمة (ISO 8601) — الافتراضي الآن' })
  @IsOptional()
  @IsISO8601()
  asOf?: string;

  @ApiPropertyOptional({ description: 'حصر الأرصدة النقدية بفرع واحد — الافتراضي كل الفروع' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
