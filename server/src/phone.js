/**
 * An Iranian mobile number as +989XXXXXXXXX, or null for anything else.
 * Accepts what Telegram sends (`989121234567`, `+989121234567`) and what people
 * type (`09121234567`, `0098 912 123 4567`, Persian or Arabic digits).
 */
export function normalizeIranMobile(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const national = digits.replace(/^(0098|98|0)/, '');
  return /^9\d{9}$/.test(national) ? `+98${national}` : null;
}
