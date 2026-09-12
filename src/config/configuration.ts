export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-to-a-long-random-string',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  mfa: {
    // مفتاح تشفير سرّ TOTP وقت السكون (AES-256-GCM) — 32 بايت (64 خانة سداسية عشرية).
    // القيمة الافتراضية هنا لبيئة التطوير المحلية فقط؛ يجب توليد مفتاح فعلي وضبطه
    // كمتغيّر بيئة في أي بيئة إنتاجية (openssl rand -hex 32).
    encryptionKey:
      process.env.MFA_ENCRYPTION_KEY ??
      '2f1c9a4e7b6d3f0851a2c4e6b8d0f2a41c3e5a7b9d1f3042c5e7a9b1d3f5062e',
    issuer: process.env.MFA_ISSUER ?? 'ExLibya',
    challengeTokenExpiresIn: process.env.MFA_CHALLENGE_EXPIRES_IN ?? '5m',
  },
  fx: {
    // الحد الأقصى المسموح به لانحراف السعر الجديد عن آخر سعر منشور، كنسبة مئوية،
    // قبل أن يرفضه قاطع الدائرة التلقائي (انظر FxRatesService.checkDeviation)
    maxDeviationPercent: parseFloat(process.env.FX_MAX_DEVIATION_PERCENT ?? '8'),
  },
  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v20.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    // يتحقق منه Meta أثناء ربط الرابط الخلفي (webhook) لأول مرة
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'change-me-verify-token',
    // يوقّع به Meta كل استدعاء Webhook (X-Hub-Signature-256) للتحقق من مصدره
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
    // نسبة انحراف السعر التي تستوجب بثّ تحديث جماعي للمشتركين (أقل من حد قاطع الدائرة عمدًا)
    broadcastDeviationPercent: parseFloat(process.env.WHATSAPP_BROADCAST_DEVIATION_PERCENT ?? '2'),
  },
});
