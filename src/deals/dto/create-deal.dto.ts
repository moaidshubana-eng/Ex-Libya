import { ApiProperty } from '@nestjs/swagger';
import { DealDirection, RateType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateDealDto {
  @ApiProperty({ description: 'معرّف العميل' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({
    required: false,
    description: 'الفرع المنفّذ للصفقة — إلزامي فقط لمستخدم غير مرتبط بفرع ثابت',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    enum: DealDirection,
    description: 'BUY: الشركة تشتري العملة من العميل — SELL: الشركة تبيعها له',
  })
  @IsEnum(DealDirection)
  direction!: DealDirection;

  @ApiProperty({ enum: RateType, description: 'السعر الذي تُسعَّر به الصفقة: الرسمي أم الموازي' })
  @IsEnum(RateType)
  rateType!: RateType;

  @ApiProperty({ description: 'كمية العملة الأجنبية محل الصفقة', example: '5000.00' })
  @IsDecimalString(2)
  amount!: string;
}
