import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { AccountingService } from './accounting.service';
import { BalanceSheetQuery } from './dto/balance-sheet.query';
import { ListJournalEntriesQuery } from './dto/list-journal-entries.query';
import { PostJournalEntryDto } from './dto/post-journal-entry.dto';
import { ReverseJournalEntryDto } from './dto/reverse-journal-entry.dto';

const LEDGER_ROLES = [StaffRole.ADMIN, StaffRole.TREASURY_MANAGER];
const FINANCIALS_ROLES = [
  StaffRole.ADMIN,
  StaffRole.TREASURY_MANAGER,
  StaffRole.COMPLIANCE_OFFICER,
];

@ApiTags('المحاسبة العامة (دفتر الأستاذ والقوائم المالية)')
@ApiBearerAuth()
@Controller('accounting')
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  @Get('accounts')
  @Roles(...FINANCIALS_ROLES)
  @ApiOperation({ summary: 'شجرة الحسابات الكاملة' })
  listAccounts() {
    return this.accountingService.listAccounts();
  }

  @Post('journal-entries')
  @Roles(...LEDGER_ROLES)
  @ApiOperation({ summary: 'ترحيل قيد يومية يدوي (رأس المال، الأصول الثابتة، القروض، الضريبة...)' })
  postManualEntry(@Body() dto: PostJournalEntryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.accountingService.postManualEntry(dto, actor);
  }

  @Get('journal-entries')
  @Roles(...FINANCIALS_ROLES)
  @ApiOperation({ summary: 'دفتر اليومية — فلترة بالفترة/الحساب/نوع المصدر' })
  listJournalEntries(@Query() query: ListJournalEntriesQuery) {
    return this.accountingService.listJournalEntries(query);
  }

  @Get('journal-entries/:id')
  @Roles(...FINANCIALS_ROLES)
  @ApiOperation({ summary: 'تفاصيل قيد يومية واحد' })
  findOneEntry(@Param('id') id: string) {
    return this.accountingService.findOneEntry(id);
  }

  @Post('journal-entries/:id/reverse')
  @Roles(...LEDGER_ROLES)
  @ApiOperation({
    summary: 'عكس قيد سابق بقيد جديد يبادل المدين بالدائن (لا تعديل ولا حذف للقيد الأصلي)',
  })
  reverseEntry(
    @Param('id') id: string,
    @Body() dto: ReverseJournalEntryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.accountingService.reverseEntry(id, dto, actor);
  }

  @Get('balance-sheet')
  @Roles(...FINANCIALS_ROLES)
  @ApiOperation({
    summary: 'قائمة المركز المالي (الميزانية) عند لحظة معيّنة — أصول، خصوم، حقوق ملكية',
  })
  getBalanceSheet(@Query() query: BalanceSheetQuery) {
    return this.accountingService.getBalanceSheet(query);
  }

  @Get('income-statement')
  @Roles(...FINANCIALS_ROLES)
  @ApiOperation({ summary: 'قائمة الدخل لفترة — الإيرادات والمصاريف وصافي الربح قبل/بعد الضريبة' })
  getIncomeStatement(@Query() query: ReportPeriodQuery) {
    return this.accountingService.getIncomeStatement(query);
  }
}
