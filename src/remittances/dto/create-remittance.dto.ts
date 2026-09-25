import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RemittanceCustomerType, RemittanceProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateRemittanceDto {
  @ApiProperty({ enum: RemittanceProvider })
  @IsEnum(RemittanceProvider)
  provider!: RemittanceProvider;

  @ApiProperty({ enum: RemittanceCustomerType })
  @IsEnum(RemittanceCustomerType)
  customerType!: RemittanceCustomerType;

  @ApiPropertyOptional({
    description: 'إلزامي فقط عند customerType = INTERNAL — معرّف العميل المسجَّل في النظام',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    description: 'إلزامي فقط عند customerType = EXTERNAL — اسم الزبون العابر غير المسجَّل',
  })
  @IsOptional()
  @IsString()
  externalCustomerName?: string;

  @ApiPropertyOptional({ description: 'هاتف الزبون العابر — اختياري حتى مع EXTERNAL' })
  @IsOptional()
  @IsString()
  externalCustomerPhone?: string;

  @ApiProperty({
    description: 'اسم الطرف الآخر — المستفيد النهائي في ليبيا',
    example: 'محمد علي الفيتوري',
  })
  @IsString()
  @MinLength(3, { message: 'اسم الطرف الآخر يجب ألا يقل عن 3 أحرف' })
  counterpartyName!: string;

  @ApiProperty({
    description: 'MTCN لوسترن يونيون أو الرقم المرجعي لموني جرام',
    example: '9214563870',
  })
  @IsString()
  @MinLength(3, { message: 'الرقم المرجعي إلزامي لتتبّع الحوالة عبر الشبكة' })
  referenceNumber!: string;

  @ApiPropertyOptional({ description: 'رمز بلد الطرف الآخر (اختياري)', example: 'EG' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiProperty({
    description: 'القيمة الأساسية للحوالة (ما يُسلَّم فعليًا للمستفيد في ليبيا) — دومًا بالدولار',
    example: '500.00',
  })
  @IsDecimalString(2)
  principalAmount!: string;

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
