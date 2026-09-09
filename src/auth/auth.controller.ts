import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { ConfirmMfaDto } from './dto/confirm-mfa.dto';
import { DisableMfaDto } from './dto/disable-mfa.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';
import { AuthenticatedUser } from './types/authenticated-user.type';

@ApiTags('المصادقة')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'تسجيل الدخول — يعيد رمز وصول مباشرة، أو رمز تحدّي إن كانت المصادقة الثنائية مفعّلة',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'الخطوة الثانية من تسجيل الدخول: تأكيد رمز TOTP أو رمز استرداد' })
  verifyMfa(@Body() dto: VerifyMfaDto) {
    return this.authService.verifyMfa(dto);
  }

  @ApiBearerAuth()
  @Post('mfa/setup')
  @ApiOperation({ summary: 'بدء إعداد مصادقة ثنائية جديدة (يعيد السرّ ورابط QR)' })
  setupMfa(@CurrentUser() actor: AuthenticatedUser) {
    return this.authService.setupMfa(actor.id);
  }

  @ApiBearerAuth()
  @Post('mfa/confirm')
  @ApiOperation({
    summary: 'تأكيد الإعداد بأول رمز صحيح — يفعّل المصادقة الثنائية ويولّد رموز استرداد',
  })
  confirmMfa(@Body() dto: ConfirmMfaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.authService.confirmMfa(actor.id, dto);
  }

  @ApiBearerAuth()
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'تعطيل المصادقة الثنائية (يتطلب رمز TOTP حالي أو رمز استرداد)' })
  disableMfa(@Body() dto: DisableMfaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.authService.disableMfa(actor.id, dto);
  }
}
