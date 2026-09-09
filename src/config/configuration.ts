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
  },
});
