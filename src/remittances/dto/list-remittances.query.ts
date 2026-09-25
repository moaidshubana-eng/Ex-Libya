import { ApiPropertyOptional } from '@nestjs/swagger';
import { RemittanceCustomerType, RemittanceProvider, RemittanceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListRemittancesQuery {
  @ApiPropertyOptional({ enum: RemittanceProvider })
  @IsOptional()
  @IsEnum(RemittanceProvider)
  provider?: RemittanceProvider;

  @ApiPropertyOptional({ enum: RemittanceStatus })
  @IsOptional()
  @IsEnum(RemittanceStatus)
  status?: RemittanceStatus;

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
