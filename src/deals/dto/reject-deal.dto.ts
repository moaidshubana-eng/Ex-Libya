import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectDealDto {
  @ApiProperty({ example: 'مستندات KYC للعميل غير مكتملة لهذا الحجم من الصفقات' })
  @IsString()
  @MinLength(5, { message: 'سبب الرفض يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
