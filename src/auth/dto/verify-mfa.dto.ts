import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class VerifyMfaDto {
  @ApiProperty({ description: 'رمز تحدّي المصادقة الثنائية المُعاد من /auth/login' })
  @IsString()
  mfaChallengeToken!: string;

  @ApiProperty({ description: 'رمز TOTP حالي أو أحد رموز الاسترداد', example: '123456' })
  @IsString()
  @MinLength(6)
  code!: string;
}
