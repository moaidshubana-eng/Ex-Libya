import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class UpdateUserRoleDto {
  @ApiProperty({ enum: StaffRole })
  @IsEnum(StaffRole)
  role!: StaffRole;

  @ApiPropertyOptional({
    description:
      'الفرع الثابت الجديد — حقل فارغ يعني إلغاء أي ارتباط بفرع صراحةً، لا الإبقاء على القديم',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiProperty({
    description: 'سبب تعديل الدور/الفرع — يُحفظ في سجل التدقيق',
    example: 'ترقية إلى مدير خزينة بعد إكمال فترة التجربة',
  })
  @IsString()
  @MinLength(5, { message: 'السبب يجب أن يكون موصّفًا بوضوح (5 أحرف على الأقل)' })
  reason!: string;
}
