import { ApiProperty } from '@nestjs/swagger';
import { KycStatus, RiskTier } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

export class UpdateKycDto {
  @ApiProperty({ enum: KycStatus })
  @IsEnum(KycStatus, { message: 'حالة التحقق يجب أن تكون PENDING أو VERIFIED أو REJECTED' })
  kycStatus!: KycStatus;

  @ApiProperty({ enum: RiskTier })
  @IsEnum(RiskTier, { message: 'تصنيف المخاطر يجب أن يكون LOW أو MEDIUM أو HIGH' })
  riskTier!: RiskTier;

  @ApiProperty({ example: 'تم استكمال مستندات الهوية والسجل التجاري' })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
