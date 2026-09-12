import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class ConfigurePositionDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiPropertyOptional({
    description:
      'سقف التعرّض الأقصى المسموح به لهذه العملة في هذا الفرع — اتركه فارغًا لإلغاء أي سقف',
    example: '500000.00',
  })
  @IsOptional()
  @IsDecimalString(2)
  maxExposure?: string;

  @ApiPropertyOptional({
    description: 'الحد الأدنى التحذيري للرصيد — اتركه فارغًا لإلغاء أي حد أدنى',
    example: '20000.00',
  })
  @IsOptional()
  @IsDecimalString(2)
  minThreshold?: string;
}
