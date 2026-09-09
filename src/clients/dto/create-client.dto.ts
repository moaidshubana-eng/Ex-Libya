import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateClientDto {
  @ApiProperty({ example: 'شركة الوفاء للاستيراد والتصدير' })
  @IsString()
  @MinLength(3, { message: 'الاسم يجب ألا يقل عن 3 أحرف' })
  fullName!: string;

  @ApiProperty({ enum: ['individual', 'company'], example: 'company' })
  @IsIn(['individual', 'company'], { message: 'نوع العميل يجب أن يكون individual أو company' })
  clientType!: 'individual' | 'company';

  @ApiProperty({ description: 'الرقم الوطني أو رقم السجل التجاري', example: '1234567890' })
  @IsString()
  nationalIdOrReg!: string;

  @ApiProperty({ description: 'رقم واتساب بالصيغة الدولية', example: '+218911234567' })
  @Matches(/^\+\d{8,15}$/, {
    message: 'رقم الهاتف يجب أن يكون بالصيغة الدولية، مثل ‎+218911234567',
  })
  phone!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ description: 'الحد اليومي بما يعادله بالدولار الأمريكي', example: '50000.00' })
  @IsDecimalString(2)
  dailyLimitUsd!: string;

  @ApiProperty({
    description: 'السقف الائتماني بما يعادله بالدولار الأمريكي',
    example: '150000.00',
  })
  @IsDecimalString(2)
  creditLimitUsd!: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  whatsappOptIn?: boolean;
}
