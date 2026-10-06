import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, ApiError, AUCTION_DESCRIPTION_MAX, type AuctionOffer, type Order, type Side } from '../../api';
import { XIcon } from '../../components/icons';
import { AmountInput, Empty, Segmented, Spinner, toast } from '../../components/ui';
import {
    assetDigits, assetName, asciiNumber, baseOf, fmtAsset, fmtDateTime, fmtPrice, fmtTime, fmtToman, groupTyped, num, parseAmount, toAmount,
} from '../../format';
import { errorMessage, t } from '../../i18n';
import { useBackHandler } from '../../nav';
import { confirm, haptic, selection } from '../../telegram';
import { balanceOf, useWallet } from '../../wallet';
import { TYPES, type OrderType } from './TradeForm';

type Filter = 'all' | 'buy' | 'sell';
const PERCENTS = [25, 50, 75, 100];

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const when = (iso: string) => (sameDay(iso) ? fmtTime(iso).slice(0, 5) : fmtDateTime(iso));

/** A description as the server keeps it: one line, trimmed. */
const cleanNote = (s: string) => s.replace(/\s+/g, ' ').trim();
const charCount = (s: string) => [...s].length;

/** What the poster added to an offer, under its sentence. */
export function OfferNote({ text }: { text?: string }) {
    return text ? <p className="ab-note" dir="auto">{text}</p> : null;
}

/** An ASCII amount grouped as an input shows it. */
function grouped(ascii: string): string {
    if (!ascii) return '';
    const [int, dec] = asciiNumber(ascii).split('.');
    const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec ? `${g}.${dec}` : g;
}

/** "USDT at 102,350 Toman, 120 of it, I buy" - an offer worded as it would be posted in a trading group. */
export function OfferText({ side, base, price, quantity, digits }: { side: Side; base: string; price: string; quantity: string; digits: number }) {
    return (
        <p className="ab-text">
            {t('board.sentence.lead', { asset: assetName(base) })}{' '}
            <strong>{fmtPrice(price, digits)}</strong> {t('board.sentence.toman')}{' '}
            {t('board.sentence.volume')} <strong>{fmtAsset(quantity, base, { trim: true })}</strong>{' '}
            <span className={side === 'buy' ? 'up' : 'down'}>{t(side === 'buy' ? 'board.sentence.buy' : 'board.sentence.sell')}</span>
        </p>
    );
}

function OfferBubble({ offer, base, digits, mine, onTake, onCancel, cancelling }: {
    offer: AuctionOffer; base: string; digits: number; mine: boolean;
    onTake: (o: AuctionOffer) => void; onCancel: (o: AuctionOffer) => void; cancelling: boolean;
}) {
    const partial = num(offer.remaining) < num(offer.quantity);
    return (
        <li className={`ab-msg ${offer.side} ${mine ? 'mine' : ''}`}>
            <div className="ab-meta">
                <span className={`side-tag ${offer.side}`}>
                    {mine ? t('board.yours') : t(offer.side === 'buy' ? 'board.buyer' : 'board.seller')}
                </span>
                <time className="hint" dateTime={offer.created_at}>{when(offer.created_at)}</time>
            </div>
            <OfferText side={offer.side} base={base} price={offer.price} quantity={offer.remaining} digits={digits} />
            <OfferNote text={offer.description} />
            <div className="ab-foot">
                <span className="hint">
                    {partial
                        ? t('board.remainingOf', { qty: fmtAsset(offer.quantity, base, { trim: true }) })
                        : `≈ ${fmtToman(num(offer.price) * num(offer.remaining))} ${t('common.toman')}`}
                </span>
                {mine ? (
                    <button type="button" className="link-button small danger" disabled={cancelling} onClick={() => onCancel(offer)}>
                        {cancelling ? t('common.loading') : t('board.withdraw')}
                    </button>
                ) : (
                    <button type="button" className={`ab-take ${offer.side === 'buy' ? 'sell' : 'buy'}`} onClick={() => { selection(); onTake(offer); }}>
                        {t(offer.side === 'buy' ? 'board.sellToThem' : 'board.buyFromThem')}
                    </button>
                )}
            </div>
        </li>
    );
}

/** "I [buy|sell] USDT at [price] Toman, [volume] of it" - the post, as a sentence with blanks to fill. */
function Composer({ symbol, digits, suggest, crossesAt, onPlaced }: {
    symbol: string; digits: number;
    /** The price to start from for each side, until the user types one. */
    suggest: Record<Side, number>;
    /** The best other users' offer on the other side, which a crossing post fills against at once. */
    crossesAt: Record<Side, number>;
    onPlaced: (o: Order) => void;
}) {
    const base = baseOf(symbol);
    const qtyDigits = Math.min(8, assetDigits(base));
    const { info } = useWallet();
    const [side, setSide] = useState<Side>('buy');
    const [price, setPrice] = useState('');
    const [touched, setTouched] = useState(false);
    const [qty, setQty] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!touched) setPrice(suggest[side] ? grouped(toAmount(suggest[side], digits)) : '');
    }, [suggest, side, touched, digits]);
    useEffect(() => {
        setTouched(false);
        setQty('');
        setError(null);
    }, [symbol]);

    const priceValue = parseAmount(price, digits);
    const qtyValue = parseAmount(qty, qtyDigits);
    const p = priceValue ? Number(priceValue) : 0;
    const q = qtyValue ? Number(qtyValue) : 0;
    const irt = balanceOf(info, 'IRT').available;
    const coin = balanceOf(info, base).available;
    const total = p * q;
    const short = side === 'buy' ? total > irt + 1e-9 : q > coin + 1e-12;
    const cross = crossesAt[side];
    const crosses = p > 0 && cross > 0 && (side === 'buy' ? p >= cross : p <= cross);
    const description = cleanNote(note);
    const noteLength = charCount(description);
    const noteLong = noteLength > AUCTION_DESCRIPTION_MAX;

    const max = () => {
        selection();
        const amount = side === 'sell' ? coin : p ? irt / p : 0;
        setQty(grouped(toAmount(amount, qtyDigits)));
        setError(null);
    };

    const submit = async () => {
        if (busy) return;
        const problem = !priceValue ? 'invalid_price' : !qtyValue ? 'invalid_quantity' : noteLong ? 'invalid_description' : short ? 'insufficient_balance' : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { order } = await api.placeAuctionOrder({ symbol, side, price: priceValue as string, quantity: qtyValue as string, description });
            haptic('success');
            const filled = num(order.filled_quantity);
            if (order.status === 'filled') toast(t(side === 'buy' ? 'trade.bought' : 'trade.sold', { qty: fmtAsset(filled, base, { trim: true }), base }));
            else if (filled > 0) toast(t('auction.partly', { qty: fmtAsset(filled, base, { trim: true }), base }));
            else toast(t('board.posted'));
            setQty('');
            setNote('');
            onPlaced(order);
        } catch (err) {
            haptic('error');
            setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`ab-composer ${side}`}>
            <div className="ab-sentence">
                <div className="ab-row ab-lead">
                    <span>{t('board.compose.i')} {t('board.compose.asset', { asset: assetName(base) })}</span>
                    <Segmented
                        className="sides small"
                        value={side}
                        onChange={(v) => { setSide(v); setError(null); }}
                        options={[
                            { value: 'buy', label: t('board.compose.buy'), tone: 'buy' },
                            { value: 'sell', label: t('board.compose.sell'), tone: 'sell' },
                        ]}
                    />
                </div>
                <label className="ab-row">
                    <span className="ab-label">{t('board.compose.atPrice')}</span>
                    <span className="ab-blank">
                        <input
                            className="ltr" inputMode={digits ? 'decimal' : 'numeric'} autoComplete="off" placeholder="0" value={price}
                            onChange={(e) => { setPrice(groupTyped(e.target.value, digits)); setTouched(true); setError(null); }}
                        />
                        <span className="ab-unit">{t('common.toman')}</span>
                    </span>
                </label>
                <label className="ab-row">
                    <span className="ab-label">{t('board.compose.volume')}</span>
                    <span className={`ab-blank ${short && q > 0 ? 'invalid' : ''}`}>
                        <input
                            className="ltr" inputMode={qtyDigits ? 'decimal' : 'numeric'} autoComplete="off" placeholder="0" value={qty}
                            onChange={(e) => { setQty(groupTyped(e.target.value, qtyDigits)); setError(null); }}
                        />
                        <span className="ab-unit">{base}</span>
                    </span>
                </label>
                <label className="ab-row">
                    <span className="ab-label">{t('board.compose.note')}</span>
                    <span className={`ab-note-field ${noteLong ? 'invalid' : ''}`}>
                        <input
                            dir="rtl" autoComplete="off" enterKeyHint="done" maxLength={AUCTION_DESCRIPTION_MAX + 20} value={note}
                            placeholder={t('board.compose.notePlaceholder')}
                            onChange={(e) => { setNote(e.target.value); setError(null); }}
                        />
                        {note && (
                            <span className="ab-note-count ltr" aria-live="polite">
                                {fmtAsset(noteLength, 'IRT')}/{fmtAsset(AUCTION_DESCRIPTION_MAX, 'IRT')}
                            </span>
                        )}
                    </span>
                </label>
            </div>

            <div className="ab-summary">
                <span>
                    {t('trade.available')}:{' '}
                    {side === 'buy' ? `${fmtToman(irt)} ${t('common.toman')}` : `${fmtAsset(coin, base, { floor: true })} ${base}`}
                    {' · '}
                    <button type="button" className="link-button small" onClick={max}>{t('board.max')}</button>
                    {touched && suggest[side] > 0 && (
                        <>
                            {' · '}
                            <button type="button" className="link-button small" onClick={() => { selection(); setTouched(false); }}>{t('board.suggested')}</button>
                        </>
                    )}
                </span>
                <strong>{total ? `${fmtToman(total)} ${t('common.toman')}` : '—'}</strong>
            </div>
            {crosses && <p className="tf-note">{t(side === 'buy' ? 'board.crossesBuy' : 'board.crossesSell', { price: fmtPrice(cross, digits) })}</p>}
            {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}

            <button type="button" className={`button ${side}`} onClick={submit} disabled={busy} aria-busy={busy}>
                {busy && <Spinner small />}
                {t(side === 'buy' ? 'board.postBuy' : 'board.postSell', { asset: assetName(base) })}
            </button>
        </div>
    );
}

/** Answering one offer: how much of it to take, at its price. */
function TakeSheet({ symbol, offer, live, digits, onDone, onClose }: {
    symbol: string; offer: AuctionOffer;
    /** The offer as the board has it now; null once it is filled or withdrawn. */
    live: AuctionOffer | null;
    digits: number; onDone: (o: Order) => void; onClose: () => void;
}) {
    const base = baseOf(symbol);
    const qtyDigits = Math.min(8, assetDigits(base));
    const { info } = useWallet();
    const side: Side = offer.side === 'buy' ? 'sell' : 'buy';
    const price = num(offer.price);
    const remaining = num((live ?? offer).remaining);
    const irt = balanceOf(info, 'IRT').available;
    const coin = balanceOf(info, base).available;
    const affordable = side === 'buy' ? (price ? irt / price : 0) : coin;
    const [qty, setQty] = useState(() => grouped(toAmount(Math.min(remaining, affordable), qtyDigits)));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useBackHandler(onClose);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const qtyValue = parseAmount(qty, qtyDigits);
    const q = qtyValue ? Number(qtyValue) : 0;
    const total = q * price;
    const short = side === 'buy' ? total > irt + 1e-9 : q > coin + 1e-12;
    const over = q > remaining + 1e-12;
    const gone = live === null;

    const submit = async () => {
        if (busy || gone) return;
        const problem = !qtyValue ? 'invalid_quantity' : over ? 'offer_short' : short ? 'insufficient_balance' : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { order } = await api.takeAuctionOffer(offer.id, qtyValue as string);
            haptic('success');
            toast(t(side === 'buy' ? 'trade.bought' : 'trade.sold', { qty: fmtAsset(order.filled_quantity, base, { trim: true }), base }));
            onDone(order);
        } catch (err) {
            haptic('error');
            setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
            setBusy(false);
        }
    };

    return createPortal(
        <div className="sheet-backdrop" onClick={onClose}>
            <div className="sheet ab-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-head">
                    <h2>{t(side === 'buy' ? 'board.take.buyTitle' : 'board.take.sellTitle', { asset: assetName(base) })}</h2>
                    <button type="button" className="icon-button ghost" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
                </div>
                <div className={`ab-quote ${offer.side}`}>
                    <span className={`side-tag ${offer.side}`}>{t(offer.side === 'buy' ? 'board.buyer' : 'board.seller')}</span>
                    <OfferText side={offer.side} base={base} price={offer.price} quantity={String(remaining)} digits={digits} />
                    <OfferNote text={offer.description} />
                </div>
                {gone ? (
                    <p className="tf-error" role="alert">{errorMessage('offer_gone')}</p>
                ) : (
                    <>
                        <AmountInput
                            id="ab-take-qty"
                            label={t(side === 'buy' ? 'board.take.howMuchBuy' : 'board.take.howMuchSell')}
                            value={qty}
                            onChange={(v) => { setQty(v); setError(null); }}
                            unit={base}
                            decimals={qtyDigits}
                            invalid={(short || over) && q > 0}
                        />
                        <div className="tf-percents">
                            {PERCENTS.map((pct) => (
                                <button key={pct} type="button" onClick={() => { selection(); setError(null); setQty(grouped(toAmount((remaining * pct) / 100, qtyDigits))); }}>
                                    {pct === 100 ? t('board.take.all') : `${fmtAsset(pct, 'IRT')}٪`}
                                </button>
                            ))}
                        </div>
                        <dl className="tf-summary">
                            <div><dt>{t('trade.price')}</dt><dd>{fmtPrice(price, digits)} {t('common.toman')}</dd></div>
                            <div>
                                <dt>{t('trade.available')}</dt>
                                <dd>{side === 'buy' ? `${fmtToman(irt)} ${t('common.toman')}` : `${fmtAsset(coin, base, { floor: true })} ${base}`}</dd>
                            </div>
                            <div>
                                <dt>{side === 'buy' ? t('trade.cost') : t('trade.proceeds')}</dt>
                                <dd className="strong">{total ? `${fmtToman(total)} ${t('common.toman')}` : '—'}</dd>
                            </div>
                        </dl>
                        <p className="tf-note">{t('board.take.note')}</p>
                    </>
                )}
                {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}
                <button type="button" className={`button ${side}`} onClick={submit} disabled={busy || gone} aria-busy={busy}>
                    {busy && <Spinner small />}
                    {t(side === 'buy' ? 'board.take.confirmBuy' : 'board.take.confirmSell')}
                </button>
            </div>
        </div>,
        document.body,
    );
}

/**
 * The auction as a Telegram trading group: every open order is a post - "I buy
 * USDT at X Toman, Y of it" - newest at the bottom, answered one by one; a new
 * post is written as the same sentence. The same orders as the auction's book.
 */
export function AuctionBoard({ symbol, offers, orders, loading, digits, marketBest, type, onType, onPlaced }: {
    symbol: string;
    offers: AuctionOffer[];
    /** The user's own open auction orders: their posts. */
    orders: Order[];
    loading: boolean;
    digits: number;
    /** The exchange's best prices, for a first post's price while the board is empty. */
    marketBest: { bid: number; ask: number };
    type: OrderType;
    onType: (type: OrderType) => void;
    onPlaced: (o: Order | null) => void;
}) {
    const base = baseOf(symbol);
    const [filter, setFilter] = useState<Filter>('all');
    const [taking, setTaking] = useState<AuctionOffer | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);
    const feed = useRef<HTMLOListElement>(null);
    const atBottom = useRef(true);

    const mine = useMemo(() => new Set(orders.map((o) => o.id)), [orders]);
    const shown = useMemo(() => offers.filter((o) => filter === 'all' || o.side === filter).slice().reverse(), [offers, filter]);

    // The best offer of other users on each side: what a post would fill against, and where its price starts.
    const others = offers.filter((o) => !mine.has(o.id));
    const bestSell = Math.min(...others.filter((o) => o.side === 'sell').map((o) => num(o.price)), Infinity);
    const bestBuy = Math.max(...others.filter((o) => o.side === 'buy').map((o) => num(o.price)), 0);
    const crossesAt = useMemo(() => ({ buy: Number.isFinite(bestSell) ? bestSell : 0, sell: bestBuy }), [bestSell, bestBuy]);
    const suggest = useMemo(() => ({
        buy: bestBuy || marketBest.bid || 0,
        sell: (Number.isFinite(bestSell) ? bestSell : 0) || marketBest.ask || 0,
    }), [bestBuy, bestSell, marketBest.bid, marketBest.ask]);

    // Like a chat: open at the newest post, and follow new ones while the user is at the bottom.
    useLayoutEffect(() => {
        const el = feed.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [shown.length, filter]);
    // The feed's height follows the viewport, which the phone's keyboard shrinks.
    useEffect(() => {
        const el = feed.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            if (atBottom.current) el.scrollTop = el.scrollHeight;
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const cancel = async (o: AuctionOffer) => {
        if (!(await confirm(t('board.withdrawConfirm')))) return;
        setCancelling(o.id);
        try {
            const res = await api.cancelAuctionOrder(o.id);
            haptic('success');
            toast(t('board.withdrawn'));
            onPlaced(res.order);
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger');
        } finally {
            setCancelling(null);
        }
    };

    return (
        <section className="panel board">
            <div className="tf-types" role="tablist">
                {TYPES.map((ty) => (
                    <button key={ty} type="button" role="tab" aria-selected={type === ty} className={type === ty ? 'active' : ''}
                            onClick={() => { selection(); onType(ty); }}>
                        {t(`trade.${ty}`)}
                    </button>
                ))}
            </div>
            <div className="panel-head ab-head">
                <h2>{t('board.title', { asset: assetName(base) })}</h2>
                <Segmented
                    className="small"
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: t('board.filter.all') },
                        { value: 'buy', label: t('board.filter.buy') },
                        { value: 'sell', label: t('board.filter.sell') },
                    ]}
                />
            </div>

            <ol
                ref={feed}
                className="ab-feed"
                onScroll={(e) => {
                    const el = e.currentTarget;
                    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
            >
                {shown.length ? shown.map((o) => (
                    <OfferBubble
                        key={o.id} offer={o} base={base} digits={digits} mine={mine.has(o.id)}
                        onTake={setTaking} onCancel={cancel} cancelling={cancelling === o.id}
                    />
                )) : (
                    <li className="ab-empty">{loading ? <Spinner /> : <Empty text={t('board.empty')} />}</li>
                )}
            </ol>

            <Composer symbol={symbol} digits={digits} suggest={suggest} crossesAt={crossesAt} onPlaced={onPlaced} />

            {taking && (
                <TakeSheet
                    symbol={symbol} offer={taking} digits={digits}
                    live={offers.find((o) => o.id === taking.id) ?? null}
                    onDone={() => setTaking(null)}
                    onClose={() => setTaking(null)}
                />
            )}
        </section>
    );
}
