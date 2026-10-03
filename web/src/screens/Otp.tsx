import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type OtpSent } from '../api';
import { MessageIcon } from '../components/icons';
import { MainAction } from '../components/MainAction';
import { Alert, Badge, OtpInput, useCountdown } from '../components/ui';
import { errorMessage, faDigits, formatPhone, t } from '../i18n';
import { haptic } from '../telegram';

/**
 * Asks for the code just sent by SMS: sends one when shown, offers another
 * after the cooldown, and hands the typed code to `verify`. Used to open a
 * session and to confirm each withdrawal.
 */
export function OtpForm({ phone, send, verify, submitText }: {
    phone: string;
    send: () => Promise<OtpSent>;
    verify: (code: string) => Promise<void>;
    submitText: string;
}) {
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<{ code: string; attemptsLeft?: number } | null>(null);
    const [resendAt, setResendAt] = useState(0);
    const wait = useCountdown(resendAt);

    const sendCode = useCallback(async () => {
        setSending(true);
        try {
            const sent = await send();
            setResendAt(Date.now() + sent.resend_in * 1000);
            setError(null);
        } catch (err) {
            const e = err instanceof ApiError ? err : null;
            // Already sent a moment ago (the app was reopened): that code still works.
            if (e?.code === 'otp_too_soon') setResendAt(Date.now() + Number(e.data.retry_after ?? 60) * 1000);
            else setError({ code: e?.code ?? 'unknown' });
        } finally {
            setSending(false);
        }
    }, [send]);

    const sentOnce = useRef(false);
    useEffect(() => {
        if (sentOnce.current) return;
        sentOnce.current = true;
        void sendCode();
    }, [sendCode]);

    const submit = async (value = code) => {
        if (busy) return;
        if (value.length !== 6) {
            setError({ code: 'otp_invalid' });
            haptic('error');
            return;
        }
        setBusy(true);
        try {
            await verify(value);
            haptic('success');
        } catch (err) {
            haptic('error');
            const e = err instanceof ApiError ? err : null;
            setError({ code: e?.code ?? 'unknown', attemptsLeft: e?.data.attempts_left as number | undefined });
            if (e?.code?.startsWith('otp_')) setCode('');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <header className="hero">
                <span className="hero-art"><Badge icon={MessageIcon} size="lg" /></span>
                <h1>{t('otp.title')}</h1>
                <p className="lead">{t('otp.body', { phone: `\u2066${formatPhone(phone)}\u2069` })}</p>
            </header>

            <OtpInput value={code} onChange={(v) => { setCode(v); if (error) setError(null); }} onComplete={submit} error={Boolean(error)} disabled={busy} />

            {error && (
                <Alert>
                    {errorMessage(error.code)}
                    {error.code === 'otp_wrong' && error.attemptsLeft !== undefined && ` ${t('otp.attemptsLeft', { n: faDigits(error.attemptsLeft) })}`}
                </Alert>
            )}

            <div className="resend">
                {wait > 0 ? (
                    <span className="hint">{t('otp.resendIn', { s: faDigits(wait) })}</span>
                ) : (
                    <button type="button" className="link-button" onClick={sendCode} disabled={sending}>
                        {sending ? t('otp.sending') : t('otp.resend')}
                    </button>
                )}
            </div>

            <MainAction text={busy ? t('otp.checking') : submitText} onClick={() => submit()} busy={busy} />
        </>
    );
}

/** After sign-in: the session reaches money only once the phone's SMS code is typed. */
export function OtpScreen({ phone, send, verify }: { phone: string; send: () => Promise<OtpSent>; verify: (code: string) => Promise<void> }) {
    return (
        <main className="screen enter">
            <OtpForm phone={phone} send={send} verify={verify} submitText={t('otp.submit')} />
            <p className="footnote">{t('otp.why')}</p>
        </main>
    );
}
