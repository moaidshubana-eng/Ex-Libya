import { ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus, RiskTier } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListClientsQuery {
  @ApiPropertyOptional({ description: 'بحث بالاسم أو الرقم الوطني/السجل أو رقم الهاتف' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: RiskTier })
  @IsOptional()
  @IsEnum(RiskTier)
  riskTier?: RiskTier;

  @ApiPropertyOptional({ enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus)
  kycStatus?: KycStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
