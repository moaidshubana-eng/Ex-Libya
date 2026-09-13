import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateBankDto {
  @ApiProperty({ description: 'رمز مختصر فريد للحساب المصرفي', example: 'ALJ-USD' })
  @Matches(/^[A-Z0-9-]{2,10}$/, {
    message: 'الرمز يجب أن يكون أحرفًا لاتينية كبيرة وأرقامًا (2-10 خانات)',
  })
  code!: string;

  @ApiProperty({ example: 'مصرف الجمهورية — الحساب الرئيسي' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiPropertyOptional({ description: 'رقم الحساب المصرفي — مرجعي فقط', example: '0123456789' })
  @IsOptional()
  @IsString()
  accountNumber?: string;
}
