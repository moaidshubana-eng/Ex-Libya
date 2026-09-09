import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class UpdateLimitsDto {
  @ApiProperty({ example: '80000.00' })
  @IsDecimalString(2)
  dailyLimitUsd!: string;

  @ApiProperty({ example: '200000.00' })
  @IsDecimalString(2)
  creditLimitUsd!: string;

  @ApiProperty({
    description: 'سبب تعديل الحدود — يُحفظ في سجل التدقيق',
    example: 'ترقية العميل بعد مراجعة نشاطه التجاري',
  })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
