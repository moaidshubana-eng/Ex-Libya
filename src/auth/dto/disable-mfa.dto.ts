import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class DisableMfaDto {
  @ApiProperty({ description: 'رمز TOTP حالي أو أحد رموز الاسترداد', example: '123456' })
  @IsString()
  @MinLength(6)
  code!: string;
}
