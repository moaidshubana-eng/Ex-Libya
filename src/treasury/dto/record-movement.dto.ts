import { ApiProperty } from '@nestjs/swagger';
import { MovementType } from '@prisma/client';
import { IsEnum, IsString, Length, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class RecordMovementDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({ enum: MovementType })
  @IsEnum(MovementType)
  type!: MovementType;

  @ApiProperty({
    description: 'قيمة موجبة دومًا؛ الاتجاه (زيادة/نقصان) يحدده type',
    example: '10000.00',
  })
  @IsDecimalString(2)
  amount!: string;

  @ApiProperty({ example: 'تغذية الخزينة من الحساب المصرفي الرئيسي' })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
