import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectRemittanceDto {
  @ApiProperty({ example: 'تسجيل مكرر بالخطأ' })
  @IsString()
  @MinLength(5, { message: 'سبب الرفض يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
