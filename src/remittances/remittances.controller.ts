import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { CreateRemittanceDto } from './dto/create-remittance.dto';
import { ListRemittancesQuery } from './dto/list-remittances.query';
import { RejectRemittanceDto } from './dto/reject-remittance.dto';
import { RemittancesService } from './remittances.service';

const REPORT_ROLES = [StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.COMPLIANCE_OFFICER];

@ApiTags('الحوالات (تركيا↔ليبيا)')
@ApiBearerAuth()
@Controller('remittances')
export class RemittancesController {
  constructor(private readonly remittancesService: RemittancesService) {}

  @Post()
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.TELLER)
  @ApiOperation({ summary: 'تسجيل حوالة جديدة (قيد التعديل — بلا ترحيل محاسبي بعد)' })
  create(@Body() dto: CreateRemittanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.remittancesService.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الحوالات مع فلترة بالشبكة/الحالة/العميل/الفرع/الفترة' })
  findAll(@Query() query: ListRemittancesQuery) {
    return this.remittancesService.findAll(query);
  }

  @Get('summary')
  @Roles(...REPORT_ROLES)
  @ApiOperation({
    summary: 'ملخص أداء وحدة الحوالات لفترة: الحوالات المسحوبة (WITHDRAWN) فقط، مجمَّعة حسب الشبكة',
  })
  getSummary(@Query() query: ReportPeriodQuery) {
    return this.remittancesService.getSummary(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل حوالة واحدة' })
  findOne(@Param('id') id: string) {
    return this.remittancesService.findOne(id);
  }

  @Post(':id/withdraw')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({
    summary: 'تسجيل السحب الفعلي (تم السحب) — يُرحِّل هامش الحوالة محاسبيًا؛ لا رجعة بعده',
  })
  withdraw(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.remittancesService.withdraw(id, actor);
  }

  @Post(':id/reject')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'رفض حوالة قيد التعديل (بلا حذف فعلي — تبقى ظاهرة كمرفوضة)' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectRemittanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.remittancesService.reject(id, dto, actor);
  }
}
