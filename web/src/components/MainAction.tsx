import { useEffect, useRef } from 'react';

import { tap, webApp } from '../telegram';

interface Props {
    text: string;
    onClick: () => void;
    busy?: boolean;
    /** Telegram's shimmer, for the one action a screen exists for. */
    shine?: boolean;
}

/**
 * A screen's primary action. Inside Telegram it is Telegram's own bottom
 * button (native, above the keyboard, in the theme's colours); elsewhere,
 * such as the development preview, an equivalent button pinned to the bottom.
 */
export function MainAction({ text, onClick, busy = false, shine = false }: Props) {
    const app = webApp();
    const handler = useRef(onClick);
    handler.current = onClick;

    useEffect(() => {
        if (!app) return;
        const button = app.MainButton;
        const click = () => {
            tap();
            handler.current();
        };
        button.onClick(click);
        return () => {
            button.offClick(click);
            button.hideProgress().setParams({ is_visible: false });
        };
    }, [app]);

    useEffect(() => {
        if (!app) return;
        const button = app.MainButton;
        button.setParams({ text, is_visible: true, is_active: !busy, has_shine_effect: shine && !busy });
        if (busy) button.showProgress(false);
        else button.hideProgress();
    }, [app, text, busy, shine]);

    if (app) return null;
    return (
        <div className="action-bar">
            <button type="button" className="button" onClick={onClick} disabled={busy} aria-busy={busy}>
                {busy && <span className="spinner small" aria-hidden="true" />}
                {text}
            </button>
        </div>
    );
}
