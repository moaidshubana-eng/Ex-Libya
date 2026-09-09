import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ConfirmMfaDto {
  @ApiProperty({ description: 'رمز TOTP الحالي من تطبيق المصادقة (6 خانات)', example: '123456' })
  @IsString()
  @Length(6, 6, { message: 'رمز التحقق يجب أن يكون 6 خانات' })
  code!: string;
}
