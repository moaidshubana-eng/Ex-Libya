export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-to-a-long-random-string',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  fx: {
    // الحد الأقصى المسموح به لانحراف السعر الجديد عن آخر سعر منشور، كنسبة مئوية،
    // قبل أن يرفضه قاطع الدائرة التلقائي (انظر FxRatesService.checkDeviation)
    maxDeviationPercent: parseFloat(process.env.FX_MAX_DEVIATION_PERCENT ?? '8'),
  },
  trading: {
    // الحد الأدنى لمبلغ الصفقة (بما يعادله بالدولار) الذي يستوجب موافقة ضابط ثانٍ
    dualApprovalThresholdUsd: parseFloat(process.env.DUAL_APPROVAL_THRESHOLD_USD ?? '30000'),
    // نسبة الاستخدام من الحد اليومي/السقف الائتماني التي تُرسل عندها تنبيه اقتراب للعميل
    limitAlertThresholdPercent: parseFloat(process.env.LIMIT_ALERT_THRESHOLD_PERCENT ?? '80'),
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
