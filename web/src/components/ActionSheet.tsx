import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from '../i18n';
import { useBackHandler } from '../nav';
import { selection } from '../telegram';
import { CheckIcon } from './icons';

export interface ActionSheetOption<T extends string> {
    value: T;
    label: string;
    description?: string;
}

// How long the sheet takes to slide away; matches .as-closing in styles.css.
const CLOSE_MS = 220;

/**
 * An iOS (Cupertino) action sheet: a title and the choices in one rounded
 * group, Cancel apart below it, rising from the bottom over a dimmed page.
 * Back, Escape, the backdrop and Cancel all dismiss it. Rendered on <body>:
 * the pages' entrance animation transforms them, which would pin a fixed
 * element to the page instead of the screen.
 */
export function ActionSheet<T extends string>({ title, message, options, value, onSelect, onClose }: {
    title?: string;
    message?: string;
    options: ActionSheetOption<T>[];
    /** The choice currently in effect, ticked. */
    value?: T;
    onSelect: (value: T) => void;
    onClose: () => void;
}) {
    const [closing, setClosing] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);

    const close = useCallback((then?: () => void) => {
        if (timer.current) return;
        setClosing(true);
        timer.current = setTimeout(() => {
            then?.();
            onClose();
        }, CLOSE_MS);
    }, [onClose]);

    useBackHandler(() => close());
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [close]);

    return createPortal(
        <div className={`as-backdrop ${closing ? 'as-closing' : ''}`} onClick={() => close()}>
            <div className="as" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
                <div className="as-group">
                    {(title || message) && (
                        <div className="as-header">
                            {title && <strong>{title}</strong>}
                            {message && <p>{message}</p>}
                        </div>
                    )}
                    {options.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            className={`as-option ${o.value === value ? 'current' : ''}`}
                            onClick={() => { selection(); close(() => onSelect(o.value)); }}
                        >
                            <span className="as-label">{o.label}</span>
                            {o.description && <span className="as-desc">{o.description}</span>}
                            {o.value === value && <CheckIcon className="as-check" />}
                        </button>
                    ))}
                </div>
                <button type="button" className="as-cancel" onClick={() => close()}>{t('common.cancel')}</button>
            </div>
        </div>,
        document.body,
    );
}
