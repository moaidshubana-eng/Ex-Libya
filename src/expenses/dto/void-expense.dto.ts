import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class VoidExpenseDto {
  @ApiProperty({ example: 'تسجيل مكرر بالخطأ' })
  @IsString()
  @MinLength(5, { message: 'سبب الإلغاء يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
