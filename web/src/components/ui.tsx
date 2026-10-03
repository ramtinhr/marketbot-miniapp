import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type SVGProps } from 'react';

import { assetColor, groupTyped } from '../format';
import { errorMessage, t } from '../i18n';
import { useNav } from '../nav';
import { selection, webApp } from '../telegram';
import { AlertIcon, CheckIcon, ChevronStartIcon, InboxIcon } from './icons';

export type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export type Tone = 'accent' | 'success' | 'warning' | 'danger';

export function Badge({ icon: I, tone = 'accent', size = 'md' }: { icon: Icon; tone?: Tone; size?: 'md' | 'lg' }) {
    return (
        <span className={`badge ${size} tone-${tone}`}>
            <I />
        </span>
    );
}

/** A coin's round badge: its ticker on its colour. */
export function CoinIcon({ asset, size = 40 }: { asset: string; size?: number }) {
    const label = asset === 'IRT' ? 'ت' : asset.slice(0, asset.length > 4 ? 3 : 4);
    return (
        <span className="coin" style={{ '--coin': assetColor(asset), '--size': `${size}px` } as CSSProperties} aria-hidden="true">
            {label}
        </span>
    );
}

/** A pushed page's title; outside Telegram (no header back button) with a back arrow. */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
    const nav = useNav();
    const inTelegram = Boolean(webApp());
    return (
        <header className="page-header">
            {!inTelegram && nav.stack.length > 0 && (
                <button type="button" className="icon-button" onClick={nav.back} aria-label={t('common.back')}>
                    <ChevronStartIcon />
                </button>
            )}
            <div className="stack">
                <h1>{title}</h1>
                {subtitle && <p className="hint">{subtitle}</p>}
            </div>
        </header>
    );
}

export function Segmented<T extends string>({ value, options, onChange, className = '' }: {
    value: T;
    options: { value: T; label: ReactNode; tone?: 'buy' | 'sell' }[];
    onChange: (value: T) => void;
    className?: string;
}) {
    return (
        <div className={`segmented ${className}`} role="tablist">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={value === o.value}
                    className={`${value === o.value ? 'active' : ''} ${o.tone ?? ''}`}
                    onClick={() => {
                        if (value !== o.value) selection();
                        onChange(o.value);
                    }}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** A number field: grouped as typed, Persian digits accepted, the unit at its end. */
export function AmountInput({ label, value, onChange, unit, decimals, placeholder, hint, invalid, action, id }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    unit?: string;
    decimals: number;
    placeholder?: string;
    hint?: ReactNode;
    invalid?: boolean;
    action?: ReactNode;
    id: string;
}) {
    return (
        <div className={`field ${invalid ? 'invalid' : ''}`}>
            <div className="field-head">
                <label htmlFor={id}>{label}</label>
                {action}
            </div>
            <div className="field-box">
                <input
                    id={id}
                    className="ltr"
                    inputMode={decimals ? 'decimal' : 'numeric'}
                    autoComplete="off"
                    placeholder={placeholder ?? '0'}
                    value={value}
                    onChange={(e) => onChange(groupTyped(e.target.value, decimals))}
                />
                {unit && <span className="field-unit">{unit}</span>}
            </div>
            {hint && <div className="field-hint">{hint}</div>}
        </div>
    );
}

/** Six boxes over one real input, so SMS autofill and paste work as usual. */
export function OtpInput({ value, onChange, onComplete, error, disabled }: {
    value: string;
    onChange: (value: string) => void;
    onComplete: (code: string) => void;
    error?: boolean;
    disabled?: boolean;
}) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return (
        <div className={`otp ${error ? 'invalid' : ''}`} onClick={() => ref.current?.focus()}>
            <input
                ref={ref}
                className="otp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={disabled}
                aria-label={t('otp.label')}
                value={value}
                onChange={(e) => {
                    const code = e.target.value
                        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
                        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
                        .replace(/\D/g, '')
                        .slice(0, 6);
                    onChange(code);
                    if (code.length === 6) onComplete(code);
                }}
            />
            {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={`otp-box ${i === value.length ? 'current' : ''} ${value[i] ? 'filled' : ''}`} aria-hidden="true">
                    {value[i] ?? ''}
                </span>
            ))}
        </div>
    );
}

/** Seconds left until `until` (a Date.now() value), ticking. */
export function useCountdown(until: number): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (until <= Date.now()) return;
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, [until]);
    return Math.max(0, Math.ceil((until - now) / 1000));
}

export function Alert({ code, children }: { code?: string | null; children?: ReactNode }) {
    if (!code && !children) return null;
    return (
        <div className="alert" role="alert" key={code ?? undefined}>
            <AlertIcon />
            <p>{children ?? errorMessage(code as string)}</p>
        </div>
    );
}

export function Empty({ icon: I = InboxIcon, text }: { icon?: Icon; text: string }) {
    return (
        <div className="empty">
            <I />
            <span>{text}</span>
        </div>
    );
}

export function Spinner({ small = false }: { small?: boolean }) {
    return <span className={`spinner ${small ? 'small' : ''}`} aria-hidden="true" />;
}

// ---- Toasts: one short message at a time, over the tab bar. ----

type ToastMsg = { id: number; text: string; tone: 'success' | 'danger' };
let toastListener: ((t: ToastMsg) => void) | null = null;
let toastId = 0;

export function toast(text: string, tone: 'success' | 'danger' = 'success'): void {
    toastListener?.({ id: ++toastId, text, tone });
}

export function Toaster() {
    const [msg, setMsg] = useState<ToastMsg | null>(null);
    useEffect(() => {
        toastListener = setMsg;
        return () => {
            toastListener = null;
        };
    }, []);
    useEffect(() => {
        if (!msg) return;
        const id = setTimeout(() => setMsg(null), 3200);
        return () => clearTimeout(id);
    }, [msg]);
    if (!msg) return null;
    return (
        <div className={`toast ${msg.tone}`} role="status" key={msg.id}>
            {msg.tone === 'success' ? <CheckIcon /> : <AlertIcon />}
            <span>{msg.text}</span>
        </div>
    );
}
