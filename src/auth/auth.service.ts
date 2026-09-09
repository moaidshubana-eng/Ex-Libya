import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // رسالة خطأ موحّدة سواء كان البريد غير موجود أو كلمة المرور خاطئة،
    // لتفادي كشف ما إذا كان البريد الإلكتروني مسجّلًا في النظام.
    const invalidCredentials = () =>
      new UnauthorizedException('البريد الإلكتروني أو كلمة المرور غير صحيحة');

    if (!user || !user.isActive) throw invalidCredentials();

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) throw invalidCredentials();

    const payload = { sub: user.id, email: user.email, role: user.role, branchId: user.branchId };
    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
      },
    };
  }

  static async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain);
  }
}
