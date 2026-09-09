import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ClientsModule } from './clients/clients.module';
import { CurrenciesModule } from './currencies/currencies.module';
import { DealsModule } from './deals/deals.module';
import { FxRatesModule } from './fx-rates/fx-rates.module';
import { TreasuryModule } from './treasury/treasury.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { AppController } from './app.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    AuditModule,
    AuthModule,
    CurrenciesModule,
    ClientsModule,
    TreasuryModule,
    WhatsAppModule,
    FxRatesModule,
    DealsModule,
  ],
  controllers: [AppController],
  providers: [
    // مُطبَّقان على كل التطبيق: المصادقة أولًا (JwtAuthGuard)، ثم فحص الأدوار (RolesGuard).
    // @Public() يتجاوز الأول؛ عدم وجود @Roles() على مسار يمرّره الثاني دون قيد.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
