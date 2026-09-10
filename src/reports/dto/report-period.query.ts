import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class ReportPeriodQuery {
  @ApiPropertyOptional({ description: 'من تاريخ (ISO 8601) — الافتراضي بداية الشهر الحالي' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'إلى تاريخ (ISO 8601) — الافتراضي الآن' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'حصر التقرير بفرع واحد — الافتراضي كل الفروع' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
