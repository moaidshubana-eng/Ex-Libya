import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetUserPasswordDto {
  @ApiProperty({ description: 'كلمة المرور الجديدة — يُنصَح المستخدم بتغييرها بعد أول دخول' })
  @IsString()
  @MinLength(8, { message: 'كلمة المرور يجب ألا تقل عن 8 أحرف' })
  newPassword!: string;

  @ApiProperty({
    description: 'سبب إعادة التعيين — يُحفظ في سجل التدقيق',
    example: 'نسي المستخدم كلمة مروره',
  })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
