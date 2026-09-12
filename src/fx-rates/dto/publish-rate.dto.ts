import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class PublishRateDto {
  @ApiProperty({ description: 'سعر الصرف مقابل الدينار الليبي', example: '7.9000' })
  @IsDecimalString(6)
  rate!: string;

  @ApiProperty({
    required: false,
    description:
      'إلزامي فقط إذا تجاوز التغيير نسبة الانحراف المسموح بها؛ يُسجَّل في سجل التدقيق ويحوّل السعر إلى "تجاوز يدوي موثّق"',
    example: 'تصحيح عاجل إثر تحديث سعر السوق الموازية',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'سبب التجاوز يجب أن يكون موصّفًا بوضوح (8 أحرف على الأقل)' })
  overrideReason?: string;
}
