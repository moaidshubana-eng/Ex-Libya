import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class PublishRateDto {
  @ApiProperty({
    description: 'السعر الرسمي (مصرف ليبيا المركزي) مقابل الدينار الليبي',
    example: '4.8500',
  })
  @IsDecimalString(6)
  officialRate!: string;

  @ApiProperty({ description: 'سعر السوق الموازية مقابل الدينار الليبي', example: '7.9000' })
  @IsDecimalString(6)
  parallelRate!: string;

  @ApiProperty({
    required: false,
    description:
      'إلزامي فقط إذا تجاوز التغيير نسبة الانحراف المسموح بها؛ يُسجَّل في سجل التدقيق ويحوّل السعر إلى "تجاوز يدوي موثّق"',
    example: 'تصحيح عاجل إثر تعميم مصرف ليبيا المركزي رقم 14 لسنة 2026',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'سبب التجاوز يجب أن يكون موصّفًا بوضوح (8 أحرف على الأقل)' })
  overrideReason?: string;
}
