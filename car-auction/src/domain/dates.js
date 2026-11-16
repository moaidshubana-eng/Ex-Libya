// تاريخ العمل: «اليوم» بتوقيت الشركة (ليبيا) لا بتوقيت الخادم (UTC في الاستضافة).
// بدونه، بين منتصف الليل والثانية صباحًا بتوقيت ليبيا تُسجَّل الحركات بتاريخ أمس ولا يُعثر على سعر صرف اليوم.
import { config } from '../config.js';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' بتوقيت الشركة للحظة d (الآن افتراضيًا) */
export const today = (d = new Date()) => fmt.format(d);
