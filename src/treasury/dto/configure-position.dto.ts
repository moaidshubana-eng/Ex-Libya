import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class ConfigurePositionDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    description: 'سقف التعرّض الأقصى المسموح به لهذه العملة في هذا الفرع',
    example: '500000.00',
  })
  @IsDecimalString(2)
  maxExposure!: string;

  @ApiProperty({ description: 'الحد الأدنى التحذيري للرصيد', example: '20000.00', default: '0' })
  @IsDecimalString(2)
  minThreshold!: string;
}
