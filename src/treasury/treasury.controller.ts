import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ConfigurePositionDto } from './dto/configure-position.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { RecordMovementDto } from './dto/record-movement.dto';
import { UpdateBranchStatusDto } from './dto/update-branch-status.dto';
import { TreasuryService } from './treasury.service';

@ApiTags('الخزينة')
@ApiBearerAuth()
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Post('branches')
  @Roles(StaffRole.ADMIN)
  @ApiOperation({ summary: 'تسجيل فرع جديد' })
  createBranch(@Body() dto: CreateBranchDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.treasuryService.createBranch(dto, actor);
  }

  @Get('branches')
  @ApiOperation({
    summary: 'قائمة الفروع — الفعّالة فقط افتراضيًا؛ أضف includeInactive=true لعرض المعطَّلة أيضًا',
  })
  listBranches(@Query('includeInactive') includeInactive?: string) {
    return this.treasuryService.listBranches(includeInactive === 'true');
  }

  @Patch('branches/:id/status')
  @Roles(StaffRole.ADMIN)
  @ApiOperation({
    summary: 'تعطيل/تفعيل فرع — بلا حذف فعلي؛ الفرع المعطَّل يختفي من كل قوائم الاختيار التشغيلية',
  })
  setBranchActive(
    @Param('id') id: string,
    @Body() dto: UpdateBranchStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.treasuryService.setBranchActive(id, dto.isActive, actor);
  }

  @Post('branches/:branchId/positions')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'تفعيل خط عملة لفرع أو تحديث سقف تعرّضه' })
  configurePosition(
    @Param('branchId') branchId: string,
    @Body() dto: ConfigurePositionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.treasuryService.configurePosition(branchId, dto, actor);
  }

  @Get('positions')
  @ApiOperation({
    summary:
      'مراكز الخزينة الحالية (اختياريًا لفرع واحد) — فروع فعّالة فقط افتراضيًا؛ أضف includeInactive=true لعرض المعطَّلة أيضًا',
  })
  listPositions(
    @Query('branchId') branchId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.treasuryService.listPositions(branchId, includeInactive === 'true');
  }

  @Post('branches/:branchId/movements')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER, StaffRole.TELLER)
  @ApiOperation({ summary: 'تسجيل حركة خزينة (إيداع/سحب/تحويل/تسوية جرد)' })
  recordMovement(
    @Param('branchId') branchId: string,
    @Body() dto: RecordMovementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.treasuryService.recordMovement(branchId, dto, actor);
  }

  @Get('branches/:branchId/movements')
  @ApiOperation({ summary: 'سجل حركات الخزينة لفرع (اختياريًا لعملة واحدة)' })
  listMovements(
    @Param('branchId') branchId: string,
    @Query('currencyCode') currencyCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.treasuryService.listMovements(
      branchId,
      currencyCode,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
