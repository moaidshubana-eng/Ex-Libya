import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { CreateRemittanceDto } from './dto/create-remittance.dto';
import { ListRemittancesQuery } from './dto/list-remittances.query';
import { VoidRemittanceDto } from './dto/void-remittance.dto';
import { RemittancesService } from './remittances.service';

const REPORT_ROLES = [StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.COMPLIANCE_OFFICER];

@ApiTags('الحوالات (وسترن يونيون / موني جرام)')
@ApiBearerAuth()
@Controller('remittances')
export class RemittancesController {
  constructor(private readonly remittancesService: RemittancesService) {}

  @Post()
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.TELLER)
  @ApiOperation({ summary: 'تسجيل حوالة وسترن يونيون أو موني جرام جديدة (إرسال أو استلام)' })
  create(@Body() dto: CreateRemittanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.remittancesService.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الحوالات مع فلترة بالشبكة/الاتجاه/تصنيف العميل/الفرع/الفترة' })
  findAll(@Query() query: ListRemittancesQuery) {
    return this.remittancesService.findAll(query);
  }

  @Get('summary')
  @Roles(...REPORT_ROLES)
  @ApiOperation({
    summary:
      'ملخص أداء وحدة الحوالات لفترة: التكلفة وقيمة البيع والربح الصافي والعدد، مجمَّعة حسب الشبكة والاتجاه',
  })
  getSummary(@Query() query: ReportPeriodQuery) {
    return this.remittancesService.getSummary(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل حوالة واحدة' })
  findOne(@Param('id') id: string) {
    return this.remittancesService.findOne(id);
  }

  @Post(':id/void')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'إلغاء حوالة مسجَّلة بالخطأ (بلا حذف فعلي — تبقى ظاهرة كملغاة)' })
  void(
    @Param('id') id: string,
    @Body() dto: VoidRemittanceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.remittancesService.void(id, dto, actor);
  }
}
