import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetLedgerDto {
  @ApiProperty({ example: 'تصفير بيانات الاختبار قبل الانطلاق الفعلي' })
  @IsString()
  @MinLength(5, { message: 'سبب التصفير يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
