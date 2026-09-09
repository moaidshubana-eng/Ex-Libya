import { Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { StaffRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ListMessagesQuery } from './dto/list-messages.query';
import { WhatsAppService } from './whatsapp.service';

@ApiTags('واتساب')
@Controller()
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  @Public()
  @Get('webhooks/whatsapp')
  @ApiExcludeEndpoint() // مسار تكامل خارجي، لا واجهة برمجية داخلية
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    return this.whatsAppService.verifyWebhookChallenge(mode, token, challenge);
  }

  @Public()
  @Post('webhooks/whatsapp')
  @ApiExcludeEndpoint()
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') signature?: string) {
    const rawBody: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    await this.whatsAppService.handleWebhookPayload(rawBody, signature);
    return { status: 'ok' };
  }

  @ApiBearerAuth()
  @Get('whatsapp/messages')
  @ApiOperation({ summary: 'سجل رسائل واتساب الواردة والصادرة' })
  findMessages(@Query() query: ListMessagesQuery) {
    return this.whatsAppService.findMessages(query);
  }

  @ApiBearerAuth()
  @Post('whatsapp/broadcast/:currencyCode')
  @Roles(StaffRole.ADMIN, StaffRole.TREASURY_MANAGER)
  @ApiOperation({ summary: 'بثّ تحديث سعر يدوي للمشتركين عبر واتساب (whatsappOptIn)' })
  broadcast(@Param('currencyCode') currencyCode: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.whatsAppService.broadcastRateUpdate(currencyCode, actor.id);
  }
}
