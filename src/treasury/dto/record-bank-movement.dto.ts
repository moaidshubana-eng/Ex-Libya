import { ApiProperty } from '@nestjs/swagger';
import { MovementType } from '@prisma/client';
import { IsIn, IsString, Length, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

/** أنواع الحركات المسموحة على حساب مصرفي — فرعية من MovementType: TRADE_BUY/SELL
 * وتسويتهما خاصة بتنفيذ صفقات الصرف على خزينة فرع، لا معنى لها على حساب مصرفي. */
export const BANK_MOVEMENT_TYPES = [
  MovementType.DEPOSIT,
  MovementType.WITHDRAWAL,
  MovementType.TRANSFER_IN,
  MovementType.TRANSFER_OUT,
  MovementType.ADJUSTMENT_INCREASE,
  MovementType.ADJUSTMENT_DECREASE,
] as const;

export class RecordBankMovementDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    enum: BANK_MOVEMENT_TYPES,
    description: 'إيداع/سحب/تحويل وارد أو صادر/تسوية جرد فقط — لا صلة لحساب مصرفي بصفقات الصرف',
  })
  @IsIn(BANK_MOVEMENT_TYPES, {
    message:
      'نوع الحركة يجب أن يكون أحد: DEPOSIT، WITHDRAWAL، TRANSFER_IN، TRANSFER_OUT، ADJUSTMENT_INCREASE، ADJUSTMENT_DECREASE',
  })
  type!: (typeof BANK_MOVEMENT_TYPES)[number];

  @ApiProperty({
    description: 'قيمة موجبة دومًا؛ الاتجاه (زيادة/نقصان) يحدده type',
    example: '10000.00',
  })
  @IsDecimalString(2)
  amount!: string;

  @ApiProperty({
    example: 'تحويل من خزينة فرع طرابلس إلى الحساب المصرفي',
  })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
