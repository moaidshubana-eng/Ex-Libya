import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListJournalEntriesQuery {
  @ApiPropertyOptional({ description: 'من تاريخ (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'إلى تاريخ (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'رمز حساب — قصر القائمة على قيود لمسته' })
  @IsOptional()
  @IsString()
  accountCode?: string;

  @ApiPropertyOptional({
    description:
      "نوع المصدر: 'Expense' | 'TreasuryMovement' | 'ClientBalanceMovement' | 'Remittance' | 'Manual'",
  })
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 30;
}
