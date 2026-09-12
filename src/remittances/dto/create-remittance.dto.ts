import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RemittanceCustomerType, RemittanceDirection, RemittanceProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MinLength } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateRemittanceDto {
  @ApiProperty({ enum: RemittanceProvider })
  @IsEnum(RemittanceProvider)
  provider!: RemittanceProvider;

  @ApiProperty({ enum: RemittanceDirection })
  @IsEnum(RemittanceDirection)
  direction!: RemittanceDirection;

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
    description: 'اسم الطرف الآخر: المستفيد النهائي (لو إرسال) أو المرسِل الأصلي (لو استلام)',
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
    description: 'القيمة الأساسية للحوالة (ما يُرسَل/يُستلَم فعليًا)',
    example: '500.00',
  })
  @IsDecimalString(2)
  principalAmount!: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    description: 'تكلفة الحوالة على الشركة (عمولة الشبكة أو ما يعادلها)',
    example: '15.00',
  })
  @IsDecimalString(2)
  cost!: string;

  @ApiProperty({ description: 'قيمة بيع الحوالة للعميل (ما تحصّله الشركة منه)', example: '25.00' })
  @IsDecimalString(2)
  saleValue!: string;

  @ApiPropertyOptional({ description: 'الفرع الذي نُفِّذت فيه الحوالة' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
