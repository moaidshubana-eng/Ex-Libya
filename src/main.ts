import 'reflect-metadata';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // نعطّل مُحلّل جسم الطلب الافتراضي لنضبطه يدويًا أدناه: التحقق من توقيع
  // واتساب (X-Hub-Signature-256) يحتاج الجسم الخام (Buffer) قبل تحويله JSON.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // لوحة التحكم (public/index.html) تُخدَّم من نفس الخادم على المسار الرئيسي "/" —
  // فلا حاجة لملف HTML منفصل يُدار يدويًا على جهاز أي مستخدم؛ أي تعديل يُدفع على
  // الفرع ينعكس تلقائيًا هنا مع بقية الخادم.
  app.useStaticAssets(join(process.cwd(), 'public'));

  app.use(
    express.json({
      verify: (req: any, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('منصّة الصرف الليبية — API')
    .setDescription('واجهة برمجة التطبيقات لإدارة الخزينة والعملاء وأسعار الصرف')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get<number>('port')!;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`تشغيل الخادم على المنفذ ${port} — التوثيق التفاعلي على /api/docs`);
}

bootstrap();
