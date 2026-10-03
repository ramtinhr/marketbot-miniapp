import { useState, type CSSProperties, type ReactNode } from 'react';

import type { DepthLevel, Order } from '../../api';
import { Segmented } from '../../components/ui';
import { baseOf, fmtAsset, fmtPercent, fmtPrice, fmtToman, num } from '../../format';
import { t } from '../../i18n';
import { selection } from '../../telegram';
import { cumulative, type MarketState, type Quote } from './market';

type View = 'both' | 'bids' | 'asks';
type BookSide = 'bid' | 'ask';
const ROWS = 8;

function BookLine({ side, level, cum, maxCum, digits, base, mine, onPick }: {
    side: BookSide; level: DepthLevel; cum: number; maxCum: number; digits: number; base: string; mine: boolean;
    onPick: (side: BookSide, price: number) => void;
}) {
    const price = num(level.price);
    const qty = num(level.quantity);
    const pct = maxCum > 0 ? Math.min(100, (cum / maxCum) * 100) : 0;
    return (
        <button
            type="button"
            className={`ob-row ${side} ${mine ? 'mine' : ''}`}
            style={{ '--depth': `${pct.toFixed(1)}%` } as CSSProperties}
            onClick={() => { selection(); onPick(side, price); }}
        >
            <span className="ob-price">{fmtPrice(price, digits)}</span>
            <span>{fmtAsset(qty, base)}</span>
            <span className="ob-dim">{fmtToman(price * qty)}</span>
        </button>
    );
}

function ViewIcon({ view }: { view: View }) {
    return <span className={`ob-view-icon ${view}`} aria-hidden="true"><i /><i /></span>;
}

/** The book as on the dashboard's market page: asks above the spread, bids below, depth behind each row. */
export function OrderBook({ symbol, s, quote, digits, onPick }: {
    symbol: string; s: MarketState; quote: Quote; digits: number; onPick: (side: BookSide, price: number) => void;
}) {
    const [view, setView] = useState<View>('both');
    const base = baseOf(symbol);
    const rows = view === 'both' ? ROWS : ROWS * 2;
    const minePrices = (side: 'buy' | 'sell') => new Set(s.orders.filter((o: Order) => o.side === side).map((o) => num(o.price)));

    let asksBody: ReactNode = null;
    let bidsBody: ReactNode = null;
    let ratio: number | null = null;
    const empty = <div className="ob-empty">{t('book.empty')}</div>;
    if (!s.depth) {
        asksBody = <div className="ob-empty">{s.loading ? t('book.loading') : t('book.waiting')}</div>;
    } else {
        const asks = s.depth.asks.slice(0, rows);
        const bids = s.depth.bids.slice(0, rows);
        const askCum = cumulative(asks);
        const bidCum = cumulative(bids);
        const askTotal = askCum.at(-1) ?? 0;
        const bidTotal = bidCum.at(-1) ?? 0;
        const maxCum = Math.max(askTotal, bidTotal);
        if (askTotal + bidTotal > 0) ratio = (bidTotal / (askTotal + bidTotal)) * 100;
        const mineAsk = minePrices('sell');
        const mineBid = minePrices('buy');
        // Asks read upwards from the spread, so the best ask sits just above it.
        asksBody = asks.length
            ? asks.map((l, i) => (
                <BookLine key={l.price} side="ask" level={l} cum={askCum[i]} maxCum={maxCum} digits={digits} base={base} mine={mineAsk.has(num(l.price))} onPick={onPick} />
            )).reverse()
            : empty;
        bidsBody = bids.length
            ? bids.map((l, i) => (
                <BookLine key={l.price} side="bid" level={l} cum={bidCum[i]} maxCum={maxCum} digits={digits} base={base} mine={mineBid.has(num(l.price))} onPick={onPick} />
            ))
            : empty;
    }

    const headline = quote.last ?? quote.mid;
    const dir = s.direction > 0 ? 'up' : s.direction < 0 ? 'down' : '';

    return (
        <section className="panel ob">
            <div className="panel-head">
                <h2>{t('book.title')}</h2>
                <Segmented
                    className="small icons"
                    value={view}
                    onChange={setView}
                    options={(['both', 'bids', 'asks'] as View[]).map((v) => ({ value: v, label: <><ViewIcon view={v} /><span className="sr-only">{t(`book.view.${v}`)}</span></> }))}
                />
            </div>
            <div className="ob-head">
                <span>{t('book.price')}</span>
                <span>{t('book.amount', { base })}</span>
                <span>{t('book.total')}</span>
            </div>
            {view !== 'bids' && <div className="ob-side ob-asks" style={{ '--rows': rows } as CSSProperties}>{asksBody}</div>}
            <div className="ob-mid">
                <strong className={dir}>{headline === null ? '—' : fmtPrice(headline, digits)}{dir === 'up' ? ' ↑' : dir === 'down' ? ' ↓' : ''}</strong>
                <span className="ob-mid-meta">
                    {quote.spread !== null && quote.mid
                        ? t('book.spread', { spread: fmtPrice(quote.spread, digits), pct: fmtPercent((quote.spread / quote.mid) * 100, 2) })
                        : ''}
                </span>
            </div>
            {view !== 'asks' && <div className="ob-side ob-bids" style={{ '--rows': rows } as CSSProperties}>{bidsBody}</div>}
            {ratio !== null && (
                <div className="ob-ratio">
                    <span className="up">{t('book.buyers')} {fmtPercent(ratio, 0)}</span>
                    <div className="ob-ratio-bar" aria-hidden="true">
                        <i className="bid" style={{ width: `${ratio.toFixed(1)}%` }} />
                        <i className="ask" style={{ width: `${(100 - ratio).toFixed(1)}%` }} />
                    </div>
                    <span className="down">{fmtPercent(100 - ratio, 0)} {t('book.sellers')}</span>
                </div>
            )}
        </section>
    );
}
