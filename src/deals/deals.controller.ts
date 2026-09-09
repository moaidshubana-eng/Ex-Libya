import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireMfa } from '../common/decorators/require-mfa.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateDealDto } from './dto/create-deal.dto';
import { ListDealsQuery } from './dto/list-deals.query';
import { RejectDealDto } from './dto/reject-deal.dto';
import { DealsService } from './deals.service';

@ApiTags('صفقات التداول')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Post()
  @Roles(StaffRole.TELLER, StaffRole.TREASURY_MANAGER, StaffRole.ADMIN)
  @ApiOperation({ summary: 'إنشاء صفقة جديدة (تسعير وقفل سعر لمهلة 60 ثانية)' })
  create(@Body() dto: CreateDealDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.dealsService.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الصفقات مع فلترة بالحالة/العميل/الفرع' })
  findAll(@Query() query: ListDealsQuery) {
    return this.dealsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل صفقة واحدة' })
  findOne(@Param('id') id: string) {
    return this.dealsService.findOne(id);
  }

  @Post(':id/approve')
  @Roles(StaffRole.TREASURY_MANAGER, StaffRole.ADMIN)
  @RequireMfa()
  @ApiOperation({
    summary:
      'اعتماد صفقة تتجاوز حد الموافقة المزدوجة (ضابط ثانٍ، لا يجوز أن يكون منشئها؛ يستوجب مصادقة ثنائية مفعّلة)',
  })
  approve(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dealsService.approve(id, actor);
  }

  @Post(':id/reject')
  @Roles(StaffRole.TREASURY_MANAGER, StaffRole.ADMIN)
  @ApiOperation({ summary: 'رفض صفقة بانتظار الموافقة المزدوجة' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectDealDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dealsService.reject(id, dto, actor);
  }

  @Post(':id/execute')
  @Roles(StaffRole.TELLER, StaffRole.TREASURY_MANAGER, StaffRole.ADMIN)
  @ApiOperation({ summary: 'تنفيذ صفقة معتمدة — يحدّث رصيد الخزينة ويسجّل حركة مرتبطة بالصفقة' })
  execute(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dealsService.execute(id, actor);
  }

  @Post(':id/cancel')
  @Roles(StaffRole.TELLER, StaffRole.TREASURY_MANAGER, StaffRole.ADMIN)
  @ApiOperation({ summary: 'إلغاء صفقة قبل تنفيذها (لمنشئها فقط)' })
  cancel(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.dealsService.cancel(id, actor);
  }
}
