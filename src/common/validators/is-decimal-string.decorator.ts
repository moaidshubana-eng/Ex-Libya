import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * يتحقق من أن الحقل نص يمثّل رقمًا عشريًا موجبًا صالحًا (لا يتجاوز عدد المنازل المحدد).
 * تُقبل المبالغ المالية كنصوص لا كأعداد JS، لتفادي فقدان الدقة عند نقل قيم كبيرة.
 */
export function IsDecimalString(maxDecimalPlaces = 2, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDecimalString',
      target: object.constructor,
      propertyName,
      options: {
        message: `يجب أن تكون القيمة رقمًا عشريًا موجبًا بحد أقصى ${maxDecimalPlaces} منازل عشرية`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const pattern = new RegExp(`^\\d+(\\.\\d{1,${maxDecimalPlaces}})?$`);
          return pattern.test(value);
        },
      },
    });
  };
}
