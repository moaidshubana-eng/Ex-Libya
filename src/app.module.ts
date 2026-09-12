import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AccountingModule } from './accounting/accounting.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ClientsModule } from './clients/clients.module';
import { CurrenciesModule } from './currencies/currencies.module';
import { DealsModule } from './deals/deals.module';
import { ExpensesModule } from './expenses/expenses.module';
import { FxRatesModule } from './fx-rates/fx-rates.module';
import { RemittancesModule } from './remittances/remittances.module';
import { ReportsModule } from './reports/reports.module';
import { TreasuryModule } from './treasury/treasury.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { AppController } from './app.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MfaGuard } from './common/guards/mfa.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    AccountingModule,
    AuditModule,
    AuthModule,
    CurrenciesModule,
    ClientsModule,
    TreasuryModule,
    WhatsAppModule,
    FxRatesModule,
    DealsModule,
    ExpensesModule,
    RemittancesModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [
    // ثلاثة حرّاس مُطبَّقون على كل التطبيق بالترتيب: المصادقة (JwtAuthGuard)، فحص
    // الأدوار (RolesGuard)، ثم فحص المصادقة الثنائية (MfaGuard). @Public() يتجاوز
    // الأول؛ عدم وجود @Roles() أو @RequireMfa() على مسار يمرّره الثاني والثالث دون قيد.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: MfaGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
