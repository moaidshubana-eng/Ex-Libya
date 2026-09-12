import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PublishRateDto } from './dto/publish-rate.dto';
import { FxRatesService } from './fx-rates.service';

@ApiTags('أسعار الصرف')
@Controller('fx-rates')
export class FxRatesController {
  constructor(private readonly fxRatesService: FxRatesService) {}

  @Public()
  @Get('latest')
  @ApiOperation({ summary: 'أحدث سعر منشور لكل عملة مفعّلة' })
  getLatest() {
    return this.fxRatesService.getLatestRates();
  }

  @ApiBearerAuth()
  @Get(':currencyCode/history')
  @ApiOperation({ summary: 'السجل التاريخي لأسعار عملة معينة' })
  getHistory(@Param('currencyCode') currencyCode: string, @Query('limit') limit?: string) {
    return this.fxRatesService.getHistory(currencyCode, limit ? parseInt(limit, 10) : undefined);
  }

  @ApiBearerAuth()
  @Post(':currencyCode')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({
    summary: 'نشر سعر جديد لعملة (يمر عبر قاطع دائرة الانحراف؛ يتطلب سبب تجاوز عند الحاجة)',
  })
  publish(
    @Param('currencyCode') currencyCode: string,
    @Body() dto: PublishRateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.fxRatesService.publish(currencyCode, dto, actor);
  }
}
