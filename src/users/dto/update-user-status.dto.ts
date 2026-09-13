import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateUserStatusDto {
  @ApiProperty({ description: 'فعّال (يمكنه تسجيل الدخول) أم معطَّل' })
  @IsBoolean()
  isActive!: boolean;
}
