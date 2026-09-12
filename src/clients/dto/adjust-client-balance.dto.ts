import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class AdjustClientBalanceDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    enum: ['INCREASE', 'DECREASE'],
    description: 'اتجاه التصحيح اليدوي على رصيد وديعة العميل',
  })
  @IsIn(['INCREASE', 'DECREASE'], { message: 'الاتجاه يجب أن يكون INCREASE أو DECREASE' })
  direction!: 'INCREASE' | 'DECREASE';

  @ApiProperty({ description: 'قيمة موجبة دومًا؛ الاتجاه يحدده direction', example: '250.00' })
  @IsDecimalString(2)
  amount!: string;

  @ApiProperty({
    description:
      'سبب التصحيح — إلزامي ويُحفظ في سجل التدقيق؛ لا يُقبل تصحيح رصيد عميل بلا تبرير موثّق',
    example: 'تصحيح خطأ إدخال إيداع سابق برقم إيصال 1042',
  })
  @IsString()
  @MinLength(10, { message: 'سبب التصحيح يجب أن يكون موصّفًا بوضوح (10 أحرف على الأقل)' })
  reason!: string;
}
