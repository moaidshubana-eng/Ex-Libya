import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { ReportPeriodQuery } from './dto/report-period.query';
import { ReportsService } from './reports.service';

const REPORT_ROLES = [StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.COMPLIANCE_OFFICER];

@ApiTags('التقارير والتحليلات')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  @Roles(...REPORT_ROLES)
  @ApiOperation({
    summary: 'ملخص مالي شامل لفترة: حجم الصفقات المنفَّذة، المصاريف، صافي حركة الخزينة، عملاء جدد',
  })
  getSummary(@Query() query: ReportPeriodQuery) {
    return this.reportsService.getFinancialSummary(query);
  }

  @Get('expenses-by-category')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'توزيع المصاريف حسب الفئة لفترة معيّنة' })
  getExpensesByCategory(@Query() query: ReportPeriodQuery) {
    return this.reportsService.getExpensesByCategory(query);
  }

  @Get('deals-trend')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'اتجاه حجم الصفقات المنفَّذة يوميًا خلال فترة معيّنة' })
  getDealsTrend(@Query() query: ReportPeriodQuery) {
    return this.reportsService.getDealsTrend(query);
  }

  @Get('treasury-consolidated')
  @Roles(...REPORT_ROLES)
  @ApiOperation({ summary: 'إجمالي أرصدة الخزينة الموحّد عبر كل الفروع لكل عملة (لقطة حالية)' })
  getTreasuryConsolidated(@Query('branchId') branchId?: string) {
    return this.reportsService.getTreasuryConsolidated(branchId);
  }
}
