import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseCategory } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MinLength,
} from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateExpenseDto {
  @ApiProperty({ enum: ExpenseCategory })
  @IsEnum(ExpenseCategory)
  category!: ExpenseCategory;

  @ApiProperty({ example: '3500.00' })
  @IsDecimalString(2)
  amount!: string;

  @ApiProperty({ example: 'LYD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({ example: 'رواتب موظفي فرع طرابلس — سبتمبر 2026' })
  @IsString()
  @MinLength(5, { message: 'الوصف يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  description!: string;

  @ApiPropertyOptional({ description: 'الفرع المرتبط بالمصروف — اتركه فارغًا لمصروف مركزي' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'تاريخ وقوع المصروف الفعلي إن اختلف عن تاريخ التسجيل (ISO 8601) — الافتراضي الآن',
  })
  @IsOptional()
  @IsISO8601()
  expenseDate?: string;
}
