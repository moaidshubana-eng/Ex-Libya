import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class JournalLineDto {
  @ApiProperty({ description: 'رمز الحساب في شجرة الحسابات', example: '3000' })
  @IsString()
  accountCode!: string;

  @ApiPropertyOptional({
    description: 'المبلغ المدين — اترك الحقلين الآخر (credit) فارغًا',
    example: '5000.00',
  })
  @IsOptional()
  @IsDecimalString(2)
  debit?: string;

  @ApiPropertyOptional({
    description: 'المبلغ الدائن — اترك الحقل الآخر (debit) فارغًا',
    example: '5000.00',
  })
  @IsOptional()
  @IsDecimalString(2)
  credit?: string;

  @ApiProperty({ example: 'LYD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiPropertyOptional({ description: 'الفرع المرتبط بهذا السطر (اختياري)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'ملاحظة توضيحية على مستوى السطر' })
  @IsOptional()
  @IsString()
  memo?: string;
}

export class PostJournalEntryDto {
  @ApiProperty({
    description: 'وصف القيد — يظهر في دفتر اليومية والتقارير',
    example: 'زيادة رأس المال بإيداع نقدي من الشريك',
  })
  @IsString()
  @MinLength(5, { message: 'وصف القيد يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  description!: string;

  @ApiPropertyOptional({ description: 'تاريخ القيد (ISO 8601) — الافتراضي الآن' })
  @IsOptional()
  @IsISO8601()
  entryDate?: string;

  @ApiProperty({
    type: [JournalLineDto],
    description: 'سطرا القيد على الأقل، متوازنة مدين/دائن لكل عملة',
  })
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  @ArrayMinSize(2, { message: 'القيد يتطلب سطرين على الأقل' })
  lines!: JournalLineDto[];
}
