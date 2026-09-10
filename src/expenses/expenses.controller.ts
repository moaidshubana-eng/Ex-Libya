import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { VoidExpenseDto } from './dto/void-expense.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('المصاريف التشغيلية')
@ApiBearerAuth()
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post()
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'تسجيل مصروف تشغيلي جديد (رواتب، إيجار، خدمات...)' })
  create(@Body() dto: CreateExpenseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.expensesService.create(dto, actor);
  }

  @Get()
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.COMPLIANCE_OFFICER)
  @ApiOperation({ summary: 'قائمة المصاريف مع فلترة بالفئة/الفرع/الفترة' })
  findAll(@Query() query: ListExpensesQuery) {
    return this.expensesService.findAll(query);
  }

  @Get(':id')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.COMPLIANCE_OFFICER)
  @ApiOperation({ summary: 'تفاصيل مصروف واحد' })
  findOne(@Param('id') id: string) {
    return this.expensesService.findOne(id);
  }

  @Post(':id/void')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'إلغاء مصروف مسجَّل بالخطأ (بلا حذف فعلي — يبقى ظاهرًا كملغى)' })
  void(
    @Param('id') id: string,
    @Body() dto: VoidExpenseDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.expensesService.void(id, dto, actor);
  }
}
