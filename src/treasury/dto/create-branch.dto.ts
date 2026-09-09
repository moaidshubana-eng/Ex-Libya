import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class CreateBranchDto {
  @ApiProperty({ description: 'رمز مختصر فريد للفرع', example: 'TRP-01' })
  @Matches(/^[A-Z0-9-]{2,10}$/, {
    message: 'الرمز يجب أن يكون أحرفًا لاتينية كبيرة وأرقامًا (2-10 خانات)',
  })
  code!: string;

  @ApiProperty({ example: 'فرع طرابلس — شارع الجمهورية' })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiProperty({ example: 'طرابلس' })
  @IsString()
  @MinLength(2)
  city!: string;
}
