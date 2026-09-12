import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MovementType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MinLength } from 'class-validator';
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

  @ApiPropertyOptional({
    description:
      'اختياري — لا يُقبل إلا مع DEPOSIT أو WITHDRAWAL: يربط هذه الحركة برصيد وديعة عميل لدى ' +
      'الشركة (custody) فيُحدَّث رصيده تلقائيًا بنفس القيمة ضمن نفس المعاملة؛ إن تُرك فارغًا تبقى ' +
      'الحركة حركة خزينة عادية بلا أي أثر على أرصدة العملاء',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
