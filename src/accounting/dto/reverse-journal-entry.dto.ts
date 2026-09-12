import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ReverseJournalEntryDto {
  @ApiProperty({ example: 'قيد خاطئ — حساب غير صحيح، يُصحَّح بقيد يدوي جديد' })
  @IsString()
  @MinLength(5, { message: 'سبب العكس يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
