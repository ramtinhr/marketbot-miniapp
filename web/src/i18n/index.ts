import { fa, type MessageKey } from './fa';

export type { MessageKey };

/** The message for `key`, with `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
    return fa[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function faDigits(value: string | number): string {
    return String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

/** +989121234567 -> ۰۹۱۲ ۱۲۳ ۴۵۶۷, as Iranians write a mobile number. */
export function formatPhone(e164: string): string {
    const m = /^\+98(9\d{2})(\d{3})(\d{4})$/.exec(e164);
    return faDigits(m ? `0${m[1]} ${m[2]} ${m[3]}` : e164);
}

/** The message for an error code from the server or from Telegram. */
export function errorMessage(code: string): string {
    const key = `error.${code}` as MessageKey;
    return key in fa ? t(key) : t('error.unknown');
}
