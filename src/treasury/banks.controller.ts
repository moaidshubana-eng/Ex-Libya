import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { BanksService } from './banks.service';
import { ConfigureBankPositionDto } from './dto/configure-bank-position.dto';
import { CreateBankDto } from './dto/create-bank.dto';
import { RecordBankMovementDto } from './dto/record-bank-movement.dto';
import { UpdateBankStatusDto } from './dto/update-bank-status.dto';

@ApiTags('المصارف')
@ApiBearerAuth()
@Controller('treasury/banks')
export class BanksController {
  constructor(private readonly banksService: BanksService) {}

  @Post()
  @Roles(StaffRole.ADMIN)
  @ApiOperation({ summary: 'تسجيل حساب مصرفي جديد' })
  createBank(@Body() dto: CreateBankDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.banksService.createBank(dto, actor);
  }

  @Get()
  @ApiOperation({
    summary:
      'قائمة الحسابات المصرفية — الفعّالة فقط افتراضيًا؛ أضف includeInactive=true لعرض المعطَّلة أيضًا',
  })
  listBanks(@Query('includeInactive') includeInactive?: string) {
    return this.banksService.listBanks(includeInactive === 'true');
  }

  @Patch(':id/status')
  @Roles(StaffRole.ADMIN)
  @ApiOperation({
    summary:
      'تعطيل/تفعيل حساب مصرفي — بلا حذف فعلي؛ الحساب المعطَّل يختفي من كل قوائم الاختيار التشغيلية',
  })
  setBankActive(
    @Param('id') id: string,
    @Body() dto: UpdateBankStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.banksService.setBankActive(id, dto.isActive, actor);
  }

  @Post(':bankId/positions')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'تفعيل خط عملة لحساب مصرفي أو تحديث سقف تعرّضه' })
  configurePosition(
    @Param('bankId') bankId: string,
    @Body() dto: ConfigureBankPositionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.banksService.configurePosition(bankId, dto, actor);
  }

  @Get('positions')
  @ApiOperation({
    summary:
      'مراكز المصارف الحالية (اختياريًا لحساب واحد) — فعّالة فقط افتراضيًا؛ أضف includeInactive=true لعرض المعطَّلة أيضًا',
  })
  listPositions(
    @Query('bankId') bankId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.banksService.listPositions(bankId, includeInactive === 'true');
  }

  @Post(':bankId/movements')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({
    summary:
      'تسجيل حركة على حساب مصرفي (إيداع/سحب/تحويل/تسوية جرد) — مقصورة على ADMIN/TREASURY_MANAGER، ' +
      'خلافًا لحركات خزينة الفرع التي يسجّلها الصرّاف أيضًا',
  })
  recordMovement(
    @Param('bankId') bankId: string,
    @Body() dto: RecordBankMovementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.banksService.recordMovement(bankId, dto, actor);
  }

  @Get(':bankId/movements')
  @ApiOperation({ summary: 'سجل حركات حساب مصرفي (اختياريًا لعملة واحدة)' })
  listMovements(
    @Param('bankId') bankId: string,
    @Query('currencyCode') currencyCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.banksService.listMovements(
      bankId,
      currencyCode,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
