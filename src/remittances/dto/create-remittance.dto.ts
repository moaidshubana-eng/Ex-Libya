import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RemittanceProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateRemittanceDto {
  @ApiProperty({ enum: RemittanceProvider })
  @IsEnum(RemittanceProvider)
  provider!: RemittanceProvider;

  @ApiProperty({
    description: 'اسم الزبون — يُستخدم لتسجيله تلقائيًا كعميل جديد إن لم يكن هاتفه مسجَّلًا مسبقًا',
    example: 'محمد علي الفيتوري',
  })
  @IsString()
  @MinLength(3, { message: 'اسم الزبون يجب ألا يقل عن 3 أحرف' })
  customerName!: string;

  @ApiProperty({
    description:
      'هاتف الزبون — مفتاح البحث عن عميل مسجَّل مسبقًا (لدعم أكثر من حوالة له في يوم واحد)؛ ' +
      'إن لم يكن مسجَّلًا يُسجَّل تلقائيًا بهذا الاسم والهاتف',
    example: '+218910000000',
  })
  @Matches(/^\+\d{8,15}$/, {
    message: 'رقم الهاتف يجب أن يكون بالصيغة الدولية، مثل ‎+218911234567',
  })
  customerPhone!: string;

  @ApiProperty({
    description: 'MTCN لوسترن يونيون أو الرقم المرجعي لموني جرام',
    example: '9214563870',
  })
  @IsString()
  @MinLength(3, { message: 'الرقم المرجعي إلزامي لتتبّع الحوالة عبر الشبكة' })
  referenceNumber!: string;

  @ApiProperty({
    description: 'سعر الاستلام في تركيا — دومًا بالدولار',
    example: '1950.00',
  })
  @IsDecimalString(2)
  turkeyReceiptAmount!: string;

  @ApiProperty({
    description: 'سعر التسليم في ليبيا — دومًا بالدولار',
    example: '1940.00',
  })
  @IsDecimalString(2)
  libyaDeliveryAmount!: string;

  @ApiPropertyOptional({
    description:
      'بدل تركيا — هامش إضافي يدوي اختياري بالدينار الليبي فقط، منفصل تمامًا عن الربح الأساسي بالدولار (turkeyReceiptAmount - libyaDeliveryAmount)',
    example: '50.00',
  })
  @IsOptional()
  @IsDecimalString(2)
  turkeyAllowanceLyd?: string;

  @ApiPropertyOptional({ description: 'الفرع الذي نُفِّذت فيه الحوالة' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
