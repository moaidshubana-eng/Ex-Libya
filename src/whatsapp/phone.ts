/** Meta ترسل رقم المرسل كأرقام فقط بلا علامة "+"؛ نظامنا يخزّن أرقام العملاء بصيغة E.164 (بها "+"). */
export const toE164 = (digitsOnly: string): string =>
  digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`;

export const toDigitsOnly = (e164: string): string => e164.replace(/^\+/, '');
