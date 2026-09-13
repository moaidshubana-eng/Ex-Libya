import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'محمد أحمد' })
  @IsString()
  @MinLength(3, { message: 'الاسم يجب ألا يقل عن 3 أحرف' })
  fullName!: string;

  @ApiProperty({ example: 'teller2@exlibya.ly' })
  @IsEmail({}, { message: 'صيغة البريد الإلكتروني غير صحيحة' })
  email!: string;

  @ApiProperty({ description: 'كلمة مرور مبدئية — يُنصَح المستخدم بتغييرها بعد أول دخول' })
  @IsString()
  @MinLength(8, { message: 'كلمة المرور يجب ألا تقل عن 8 أحرف' })
  password!: string;

  @ApiProperty({ enum: StaffRole })
  @IsEnum(StaffRole)
  role!: StaffRole;

  @ApiPropertyOptional({
    description: 'فرع ثابت للمستخدم — اختياري (بعض الأدوار لا ترتبط بفرع واحد)',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
