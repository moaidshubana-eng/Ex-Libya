import { ApiPropertyOptional } from '@nestjs/swagger';
import { RemittanceCustomerType, RemittanceDirection, RemittanceProvider } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListRemittancesQuery {
  @ApiPropertyOptional({ enum: RemittanceProvider })
  @IsOptional()
  @IsEnum(RemittanceProvider)
  provider?: RemittanceProvider;

  @ApiPropertyOptional({ enum: RemittanceDirection })
  @IsOptional()
  @IsEnum(RemittanceDirection)
  direction?: RemittanceDirection;

  @ApiPropertyOptional({ enum: RemittanceCustomerType })
  @IsOptional()
  @IsEnum(RemittanceCustomerType)
  customerType?: RemittanceCustomerType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'من تاريخ (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'إلى تاريخ (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'تضمين الحوالات الملغاة (voided) في النتائج',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeVoided = false;

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
