import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
    api, ApiError, RIAL_BANK_METHODS, RIAL_DESCRIPTION_MAX, RIAL_METHODS,
    type RialMethod, type RialOffer, type RialOrder, type RialSide,
} from '../../api';
import { XIcon } from '../../components/icons';
import { AmountInput, Empty, PageHeader, Segmented, Spinner, toast } from '../../components/ui';
import { asciiNumber, fmtAsset, fmtDateTime, fmtTime, fmtToman, groupTyped, num, parseAmount, toAmount } from '../../format';
import { errorMessage, t } from '../../i18n';
import { listen, watchRial } from '../../live';
import { useBackHandler } from '../../nav';
import { confirm, haptic, selection } from '../../telegram';
import { balanceOf, refreshWallet, useWallet } from '../../wallet';

type SideFilter = 'all' | RialSide;
type MethodFilter = 'all' | RialMethod;
const PERCENTS = [25, 50, 75, 100];
const SAMPLE_SHEBA = 'IR820540102680020817909002';

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const when = (iso: string) => (sameDay(iso) ? fmtTime(iso).slice(0, 5) : fmtDateTime(iso));
const cleanNote = (s: string) => s.replace(/\s+/g, ' ').trim();
const charCount = (s: string) => [...s].length;
const isBank = (m: RialMethod) => RIAL_BANK_METHODS.includes(m);

function grouped(ascii: string): string {
    if (!ascii) return '';
    const [int, dec] = asciiNumber(ascii).split('.');
    const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec ? `${g}.${dec}` : g;
}

function OfferNote({ text }: { text?: string }) {
    return text ? <p className="ab-note" dir="auto">{text}</p> : null;
}

function MethodChip({ method }: { method: RialMethod }) {
    return <span className={`rial-method ${method}`}>{t(`rial.method.${method}`)}</span>;
}

function OfferText({ side, amount }: { side: RialSide; amount: string }) {
    return (
        <p className="ab-text">
            {t('rial.sentence.lead')}{' '}
            <strong>{fmtToman(amount)}</strong> {t('common.toman')}{' '}
            <span className={side === 'have' ? 'down' : 'up'}>{t(side === 'have' ? 'rial.sentence.have' : 'rial.sentence.want')}</span>
        </p>
    );
}

function OfferBubble({ offer, mine, onTake, onCancel, cancelling }: {
    offer: RialOffer; mine: boolean;
    onTake: (o: RialOffer) => void; onCancel: (o: RialOffer) => void; cancelling: boolean;
}) {
    const partial = num(offer.remaining) < num(offer.amount);
    return (
        <li className={`ab-msg ${offer.side === 'want' ? 'buy' : 'sell'} ${mine ? 'mine' : ''}`}>
            <div className="ab-meta">
                <span className={`side-tag ${offer.side === 'want' ? 'buy' : 'sell'}`}>
                    {mine ? t('rial.yours') : t(offer.side === 'have' ? 'rial.haver' : 'rial.wanter')}
                </span>
                <MethodChip method={offer.method} />
                <time className="hint" dateTime={offer.created_at}>{when(offer.created_at)}</time>
            </div>
            <OfferText side={offer.side} amount={offer.remaining} />
            <OfferNote text={offer.description} />
            <div className="ab-foot">
                <span className="hint">
                    {partial ? t('rial.remainingOf', { amount: fmtToman(offer.amount) }) : t(`rial.method.${offer.method}`)}
                </span>
                {mine ? (
                    <button type="button" className="link-button small danger" disabled={cancelling} onClick={() => onCancel(offer)}>
                        {cancelling ? t('common.loading') : t('rial.withdraw')}
                    </button>
                ) : (
                    <button
                        type="button"
                        className={`ab-take ${offer.side === 'have' ? 'buy' : 'sell'}`}
                        onClick={() => { selection(); onTake(offer); }}
                    >
                        {t(offer.side === 'have' ? 'rial.takeHave' : 'rial.takeWant')}
                    </button>
                )}
            </div>
        </li>
    );
}

function Composer({ onPlaced }: { onPlaced: (o: RialOrder) => void }) {
    const { info } = useWallet();
    const [side, setSide] = useState<RialSide>('want');
    const [method, setMethod] = useState<RialMethod>('wallet');
    const [amount, setAmount] = useState('');
    const [destination, setDestination] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const amountValue = parseAmount(amount, 0);
    const q = amountValue ? Number(amountValue) : 0;
    const irt = balanceOf(info, 'IRT').available;
    const short = side === 'have' && method === 'wallet' && q > irt + 1e-9;
    const needSheba = isBank(method) && side === 'want';
    const description = cleanNote(note);
    const noteLength = charCount(description);
    const noteLong = noteLength > RIAL_DESCRIPTION_MAX;

    const max = () => {
        selection();
        if (side === 'have' && method === 'wallet') setAmount(grouped(toAmount(irt, 0)));
        setError(null);
    };

    const submit = async () => {
        if (busy) return;
        const problem = !amountValue ? 'invalid_amount'
            : noteLong ? 'invalid_description'
            : short ? 'insufficient_balance'
            : needSheba && !destination.trim() ? 'invalid_sheba'
            : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { order } = await api.placeRialOrder({
                side,
                amount: amountValue as string,
                method,
                description,
                ...(needSheba || destination.trim() ? { destination: destination.trim() } : {}),
            });
            haptic('success');
            toast(t('rial.posted'));
            setAmount('');
            setNote('');
            if (needSheba) setDestination('');
            onPlaced(order);
            void refreshWallet();
        } catch (err) {
            haptic('error');
            setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`ab-composer ${side === 'want' ? 'buy' : 'sell'}`}>
            <div className="ab-sentence">
                <div className="ab-row ab-lead">
                    <span>{t('rial.compose.i')}</span>
                    <Segmented
                        className="sides small"
                        value={side}
                        onChange={(v) => { setSide(v); setError(null); }}
                        options={[
                            { value: 'want', label: t('rial.compose.want'), tone: 'buy' },
                            { value: 'have', label: t('rial.compose.have'), tone: 'sell' },
                        ]}
                    />
                </div>
                <label className="ab-row">
                    <span className="ab-label">{t('rial.compose.amount')}</span>
                    <span className={`ab-blank ${short && q > 0 ? 'invalid' : ''}`}>
                        <input
                            className="ltr" inputMode="numeric" autoComplete="off" placeholder="0" value={amount}
                            onChange={(e) => { setAmount(groupTyped(e.target.value, 0)); setError(null); }}
                        />
                        <span className="ab-unit">{t('common.toman')}</span>
                    </span>
                </label>
                <div className="ab-row ab-method-row">
                    <span className="ab-label">{t('rial.compose.method')}</span>
                    <div className="rial-methods" role="radiogroup" aria-label={t('rial.compose.method')}>
                        {RIAL_METHODS.map((m) => (
                            <button
                                key={m} type="button" role="radio" aria-checked={method === m}
                                className={method === m ? 'active' : ''}
                                onClick={() => { selection(); setMethod(m); setError(null); }}
                            >
                                {t(`rial.method.${m}`)}
                            </button>
                        ))}
                    </div>
                </div>
                {needSheba && (
                    <label className="ab-row">
                        <span className="ab-label">{t('rial.compose.sheba')}</span>
                        <span className="ab-blank">
                            <input
                                className="ltr" autoComplete="off" placeholder={SAMPLE_SHEBA}
                                value={destination}
                                onChange={(e) => { setDestination(e.target.value); setError(null); }}
                            />
                        </span>
                    </label>
                )}
                <label className="ab-row">
                    <span className="ab-label">{t('rial.compose.note')}</span>
                    <span className={`ab-note-field ${noteLong ? 'invalid' : ''}`}>
                        <input
                            dir="rtl" autoComplete="off" enterKeyHint="done" maxLength={RIAL_DESCRIPTION_MAX + 20} value={note}
                            placeholder={t('rial.compose.notePlaceholder')}
                            onChange={(e) => { setNote(e.target.value); setError(null); }}
                        />
                        {note && (
                            <span className="ab-note-count ltr" aria-live="polite">
                                {fmtAsset(noteLength, 'IRT')}/{fmtAsset(RIAL_DESCRIPTION_MAX, 'IRT')}
                            </span>
                        )}
                    </span>
                </label>
            </div>

            <div className="ab-summary">
                <span>
                    {t('trade.available')}: {fmtToman(irt)} {t('common.toman')}
                    {side === 'have' && method === 'wallet' && (
                        <>
                            {' · '}
                            <button type="button" className="link-button small" onClick={max}>{t('board.max')}</button>
                        </>
                    )}
                </span>
                <strong>{q ? `${fmtToman(q)} ${t('common.toman')}` : '—'}</strong>
            </div>
            <p className="tf-note">{t(`rial.methodHint.${method}`)}</p>
            {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}
            <button type="button" className={`button ${side === 'want' ? 'buy' : 'sell'}`} onClick={submit} disabled={busy} aria-busy={busy}>
                {busy && <Spinner small />}
                {t(side === 'want' ? 'rial.postWant' : 'rial.postHave')}
            </button>
        </div>
    );
}

function TakeSheet({ offer, live, onDone, onClose }: {
    offer: RialOffer;
    live: RialOffer | null;
    onDone: (o: RialOrder) => void;
    onClose: () => void;
}) {
    const { info } = useWallet();
    const remaining = num((live ?? offer).remaining);
    const irt = balanceOf(info, 'IRT').available;
    const takerIsHave = offer.side === 'want';
    const needSheba = isBank(offer.method) && !takerIsHave;
    const affordable = takerIsHave && offer.method === 'wallet' ? irt : remaining;
    const [amount, setAmount] = useState(() => grouped(toAmount(Math.min(remaining, affordable), 0)));
    const [destination, setDestination] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useBackHandler(onClose);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const amountValue = parseAmount(amount, 0);
    const q = amountValue ? Number(amountValue) : 0;
    const short = takerIsHave && offer.method === 'wallet' && q > irt + 1e-9;
    const over = q > remaining + 1e-9;
    const gone = live === null;

    const submit = async () => {
        if (busy || gone) return;
        const problem = !amountValue ? 'invalid_amount'
            : over ? 'offer_short'
            : short ? 'insufficient_balance'
            : needSheba && !destination.trim() ? 'invalid_sheba'
            : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { order } = await api.takeRialOffer(offer.id, {
                amount: amountValue as string,
                ...(needSheba ? { destination: destination.trim() } : {}),
            });
            haptic('success');
            toast(t(offer.method === 'wallet' ? 'rial.takenWallet' : 'rial.takenMatched'));
            onDone(order);
            void refreshWallet();
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
                    <h2>{t(takerIsHave ? 'rial.take.haveTitle' : 'rial.take.wantTitle')}</h2>
                    <button type="button" className="icon-button ghost" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
                </div>
                <div className={`ab-quote ${offer.side === 'want' ? 'buy' : 'sell'}`}>
                    <span className={`side-tag ${offer.side === 'want' ? 'buy' : 'sell'}`}>
                        {t(offer.side === 'have' ? 'rial.haver' : 'rial.wanter')}
                    </span>
                    <MethodChip method={offer.method} />
                    <OfferText side={offer.side} amount={String(remaining)} />
                    <OfferNote text={offer.description} />
                </div>
                {gone ? (
                    <p className="tf-error" role="alert">{errorMessage('offer_gone')}</p>
                ) : (
                    <>
                        <AmountInput
                            id="rial-take-amount"
                            label={t('rial.take.howMuch')}
                            value={amount}
                            onChange={(v) => { setAmount(v); setError(null); }}
                            unit={t('common.toman')}
                            decimals={0}
                            invalid={(short || over) && q > 0}
                        />
                        <div className="tf-percents">
                            {PERCENTS.map((pct) => (
                                <button key={pct} type="button" onClick={() => { selection(); setError(null); setAmount(grouped(toAmount((remaining * pct) / 100, 0))); }}>
                                    {pct === 100 ? t('board.take.all') : `${fmtAsset(pct, 'IRT')}٪`}
                                </button>
                            ))}
                        </div>
                        {needSheba && (
                            <label className="ab-row">
                                <span className="ab-label">{t('rial.compose.sheba')}</span>
                                <span className="ab-blank">
                                    <input
                                        className="ltr" autoComplete="off" placeholder={SAMPLE_SHEBA}
                                        value={destination}
                                        onChange={(e) => { setDestination(e.target.value); setError(null); }}
                                    />
                                </span>
                            </label>
                        )}
                        <dl className="tf-summary">
                            <div><dt>{t('rial.compose.method')}</dt><dd>{t(`rial.method.${offer.method}`)}</dd></div>
                            <div>
                                <dt>{t('trade.available')}</dt>
                                <dd>{fmtToman(irt)} {t('common.toman')}</dd>
                            </div>
                        </dl>
                        <p className="tf-note">{t(`rial.take.note.${offer.method}`)}</p>
                    </>
                )}
                {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}
                <button
                    type="button"
                    className={`button ${takerIsHave ? 'sell' : 'buy'}`}
                    onClick={submit}
                    disabled={busy || gone}
                    aria-busy={busy}
                >
                    {busy && <Spinner small />}
                    {t('rial.take.confirm')}
                </button>
            </div>
        </div>,
        document.body,
    );
}

/** The Toman board: «دارم / می‌خواهم» offers with a receive method. */
export function RialBoardPage() {
    const [offers, setOffers] = useState<RialOffer[] | null>(null);
    const [mine, setMine] = useState<RialOrder[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sideFilter, setSideFilter] = useState<SideFilter>('all');
    const [methodFilter, setMethodFilter] = useState<MethodFilter>('all');
    const [taking, setTaking] = useState<RialOffer | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);
    const feed = useRef<HTMLOListElement>(null);
    const atBottom = useRef(true);

    useEffect(() => {
        let live = true;
        Promise.all([api.rial(), api.rialOrders('open').catch(() => ({ orders: [] as RialOrder[] }))])
            .then(([board, orders]) => {
                if (!live) return;
                setOffers(board.offers);
                setMine(orders.orders);
            })
            .catch((err) => {
                if (live) setError(err instanceof ApiError ? err.code : 'unknown');
            });
        watchRial(true);
        const stop = listen((msg) => {
            if (msg.type === 'rial_offers') setOffers(msg.offers);
            else if (msg.type === 'rial_user') {
                setMine((prev) => {
                    if (!prev) return prev;
                    const byId = new Map(prev.map((o) => [o.id, o]));
                    for (const o of msg.orders) {
                        if (o.status === 'open' || o.status === 'partial') byId.set(o.id, o);
                        else byId.delete(o.id);
                    }
                    return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
                });
            }
        });
        return () => {
            live = false;
            watchRial(false);
            stop();
        };
    }, []);

    const mineIds = useMemo(() => new Set((mine ?? []).map((o) => o.id)), [mine]);
    const shown = useMemo(() => {
        let list = offers ?? [];
        if (sideFilter !== 'all') list = list.filter((o) => o.side === sideFilter);
        if (methodFilter !== 'all') list = list.filter((o) => o.method === methodFilter);
        return list;
    }, [offers, sideFilter, methodFilter]);

    useLayoutEffect(() => {
        const el = feed.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [shown]);

    const onScroll = () => {
        const el = feed.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };

    const cancel = async (offer: RialOffer) => {
        if (!(await confirm(t('rial.withdrawConfirm')))) return;
        setCancelling(offer.id);
        try {
            await api.cancelRialOrder(offer.id);
            haptic('success');
            toast(t('rial.withdrawn'));
            setOffers((prev) => prev?.filter((o) => o.id !== offer.id) ?? prev);
            setMine((prev) => prev?.filter((o) => o.id !== offer.id) ?? prev);
            void refreshWallet();
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'));
        } finally {
            setCancelling(null);
        }
    };

    const applyMine = (order: RialOrder) => {
        setMine((prev) => {
            const rest = (prev ?? []).filter((o) => o.id !== order.id);
            return order.status === 'open' || order.status === 'partial' ? [order, ...rest] : rest;
        });
    };

    return (
        <main className="screen enter rial-page">
            <PageHeader title={t('rial.title')} />
            <p className="hint rial-sub">{t('rial.subtitle')}</p>

            {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}

            <div className="rial-filters">
                <Segmented
                    className="small"
                    value={sideFilter}
                    onChange={setSideFilter}
                    options={[
                        { value: 'all', label: t('rial.filter.all') },
                        { value: 'want', label: t('rial.filter.want') },
                        { value: 'have', label: t('rial.filter.have') },
                    ]}
                />
                <div className="rial-methods filter" role="radiogroup" aria-label={t('rial.compose.method')}>
                    <button type="button" role="radio" aria-checked={methodFilter === 'all'} className={methodFilter === 'all' ? 'active' : ''}
                        onClick={() => { selection(); setMethodFilter('all'); }}>
                        {t('rial.filter.methodAll')}
                    </button>
                    {RIAL_METHODS.map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={methodFilter === m} className={methodFilter === m ? 'active' : ''}
                            onClick={() => { selection(); setMethodFilter(m); }}>
                            {t(`rial.method.${m}`)}
                        </button>
                    ))}
                </div>
            </div>

            <ol className="ab-feed" ref={feed} onScroll={onScroll}>
                {offers === null ? (
                    <li className="ab-empty"><Spinner /></li>
                ) : shown.length === 0 ? (
                    <li className="ab-empty"><Empty text={t('rial.empty')} /></li>
                ) : (
                    shown.map((o) => (
                        <OfferBubble
                            key={o.id}
                            offer={o}
                            mine={mineIds.has(o.id)}
                            onTake={setTaking}
                            onCancel={cancel}
                            cancelling={cancelling === o.id}
                        />
                    ))
                )}
            </ol>

            <Composer onPlaced={(o) => {
                applyMine(o);
                setOffers((prev) => {
                    const offer: RialOffer = {
                        id: o.id, side: o.side, amount: o.amount, remaining: o.remaining,
                        method: o.method, description: o.description, created_at: o.created_at,
                    };
                    return prev ? [offer, ...prev.filter((x) => x.id !== o.id)] : [offer];
                });
            }} />

            {taking && (
                <TakeSheet
                    offer={taking}
                    live={offers?.find((o) => o.id === taking.id) ?? null}
                    onDone={() => {
                        setTaking(null);
                        void api.rial().then((b) => setOffers(b.offers));
                        void api.rialOrders('open').then((r) => setMine(r.orders)).catch(() => {});
                    }}
                    onClose={() => setTaking(null)}
                />
            )}
        </main>
    );
}
