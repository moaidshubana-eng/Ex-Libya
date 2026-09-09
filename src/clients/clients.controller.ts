import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsQuery } from './dto/list-clients.query';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { UpdateLimitsDto } from './dto/update-limits.dto';

@ApiTags('العملاء')
@ApiBearerAuth()
@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Post()
  @Roles(StaffRole.ADMIN, StaffRole.CUSTOMER_SERVICE, StaffRole.TELLER)
  @ApiOperation({ summary: 'تسجيل عميل جديد (KYC أولي)' })
  create(@Body() dto: CreateClientDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.clientsService.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة العملاء مع بحث وفلترة' })
  findAll(@Query() query: ListClientsQuery) {
    return this.clientsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'ملف عميل واحد بالتفصيل' })
  findOne(@Param('id') id: string) {
    return this.clientsService.findOne(id);
  }

  @Patch(':id/limits')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'تعديل الحد اليومي والسقف الائتماني للعميل' })
  updateLimits(
    @Param('id') id: string,
    @Body() dto: UpdateLimitsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.clientsService.updateLimits(id, dto, actor);
  }

  @Patch(':id/kyc')
  @Roles(StaffRole.ADMIN, StaffRole.COMPLIANCE_OFFICER)
  @ApiOperation({ summary: 'تحديث حالة التحقق (KYC) وتصنيف المخاطر' })
  updateKyc(
    @Param('id') id: string,
    @Body() dto: UpdateKycDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.clientsService.updateKyc(id, dto, actor);
  }
}
