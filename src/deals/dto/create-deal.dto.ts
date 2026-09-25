import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DealCustomerType, DealDirection } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsDecimalString } from '../../common/validators/is-decimal-string.decorator';

export class CreateDealDto {
  @ApiProperty({ enum: DealCustomerType })
  @IsEnum(DealCustomerType)
  customerType!: DealCustomerType;

  @ApiPropertyOptional({
    description: 'إلزامي فقط عند customerType = INTERNAL — معرّف العميل المسجَّل في النظام',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  // لا اسم ولا هاتف للزبون الخارجي — أُلغي إدخالهما صراحةً؛ صفقة EXTERNAL
  // تُميَّز بـ customerType وحده، وتُعرَض بتسمية عامة "زبون خارجي" (انظر
  // Transaction.externalCustomerName في schema.prisma وDealsService.dealPartyName).

  @ApiProperty({
    required: false,
    description: 'الفرع المنفّذ للصفقة — إلزامي فقط لمستخدم غير مرتبط بفرع ثابت',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(3, 3, { message: 'رمز العملة يجب أن يكون 3 أحرف وفق ISO 4217' })
  currencyCode!: string;

  @ApiProperty({
    enum: DealDirection,
    description: 'BUY: الشركة تشتري العملة من العميل — SELL: الشركة تبيعها له',
  })
  @IsEnum(DealDirection)
  direction!: DealDirection;

  @ApiProperty({ description: 'كمية العملة الأجنبية محل الصفقة', example: '5000.00' })
  @IsDecimalString(2)
  amount!: string;

  @ApiProperty({
    description:
      'سعر الصفقة (سعر البيع/الشراء الفعلي المتفق عليه مع الطرف الآخر) — يُدخله الموظف يدويًا بالكامل، لا يُشتَق تلقائيًا من أي سعر صرف منشور',
    example: '7.9000',
  })
  @IsDecimalString(6)
  dealRate!: string;

  @ApiProperty({
    description:
      'سعر السوق الموازي المرجعي وقت الصفقة (يُدخله الموظف يدويًا أيضًا) — أساس احتساب هامش الربح/الخسارة الفعلي مقابل سعر الصفقة (dealRate): عند الشراء الربح إن كان سعر السوق أعلى من سعر الصفقة، وعند البيع الربح إن كان سعر الصفقة أعلى من سعر السوق',
    example: '7.9500',
  })
  @IsDecimalString(6)
  parallelMarketRate!: string;
}
