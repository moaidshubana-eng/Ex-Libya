import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** يعلّم مسارًا كمسار عام لا يتطلّب مصادقة JWT (مثل تسجيل الدخول وفحص الصحة). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
