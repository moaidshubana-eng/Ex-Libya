import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UsersService } from './users.service';

// إدارة المستخدمين والصلاحيات — مقصورة بالكامل على ADMIN؛ لا يوجد أي مسار هنا
// متاح لأي دور آخر (خلافًا لبعض وحدات أخرى تتيح القراءة للجميع).
@ApiTags('المستخدمون والصلاحيات')
@ApiBearerAuth()
@Roles(StaffRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'تسجيل مستخدم جديد بكلمة مرور مبدئية ودور وظيفي' })
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.usersService.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة المستخدمين — فلترة بالدور والحالة وبحث بالاسم/البريد' })
  findAll(@Query() query: ListUsersQuery, @Query('isActive') isActiveRaw?: string) {
    const isActive = isActiveRaw === 'true' ? true : isActiveRaw === 'false' ? false : undefined;
    return this.usersService.findAll(query, isActive);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل مستخدم واحد' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id/role')
  @ApiOperation({
    summary:
      'تغيير الدور الوظيفي والفرع الثابت — يرفض تعديل حساب المستخدم نفسه، وتنحية آخر ADMIN فعّال',
  })
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.updateRole(id, dto, actor);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'تفعيل/تعطيل حساب — يرفض تعطيل حساب المستخدم نفسه، وتعطيل آخر ADMIN فعّال',
  })
  setActive(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.setActive(id, dto.isActive, actor);
  }

  @Patch(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'إعادة تعيين كلمة مرور مستخدم (نسيان، أو تسوية أمنية)' })
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetUserPasswordDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.resetPassword(id, dto, actor);
  }
}
