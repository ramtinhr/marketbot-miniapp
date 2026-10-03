import { useEffect, useState } from 'react';

import { api, ApiError, type Order, type Side } from '../../api';
import { AmountInput, Segmented, Spinner, toast } from '../../components/ui';
import { assetDigits, asciiNumber, baseOf, fmtAsset, fmtPrice, fmtToman, parseAmount, toAmount } from '../../format';
import { errorMessage, t } from '../../i18n';
import { haptic, selection } from '../../telegram';
import { balanceOf, useWallet } from '../../wallet';
import { levelsFor, qtyForCost, walkBook, type MarketState, type Quote } from './market';

export type OrderType = 'limit' | 'market';
const PERCENTS = [25, 50, 75, 100];
// A market buy is sent at a price a little past the book (the server's
// slippage margin), and the engine holds that much Toman; leave room for it.
const MARKET_BUY_HEADROOM = 0.99;

/** A price the form was told to use (a tapped book row); `n` makes a repeat tap count. */
export interface PriceRequest { price: number; n: number }

export function TradeForm({ symbol, s, quote, digits, request, onPlaced }: {
    symbol: string;
    s: MarketState;
    quote: Quote;
    digits: number;
    request: PriceRequest | null;
    onPlaced: (order: Order | null) => void;
}) {
    const base = baseOf(symbol);
    const qtyDigits = Math.min(8, assetDigits(base));
    const { info } = useWallet();
    const [side, setSide] = useState<Side>('buy');
    const [type, setType] = useState<OrderType>('limit');
    const [price, setPrice] = useState('');
    // Until the user types a price, the limit price follows the best one on the other side of the book.
    const [priceTouched, setPriceTouched] = useState(false);
    const [qty, setQty] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const best = side === 'buy' ? quote.bestAsk : quote.bestBid;
    useEffect(() => {
        if (!priceTouched) setPrice(best ? groupNumber(toAmount(best, digits)) : '');
    }, [best, priceTouched, digits]);

    useEffect(() => {
        if (!request) return;
        setType('limit');
        setPriceTouched(true);
        setPrice(groupNumber(toAmount(request.price, digits)));
        setError(null);
    }, [request, digits]);

    useEffect(() => {
        setQty('');
        setError(null);
    }, [symbol, side]);
    useEffect(() => {
        setPriceTouched(false);
    }, [symbol]);

    const irt = balanceOf(info, 'IRT').available;
    const coin = balanceOf(info, base).available;
    const priceValue = parseAmount(price);
    const qtyValue = parseAmount(qty, qtyDigits);
    const p = priceValue ? Number(priceValue) : 0;
    const q = qtyValue ? Number(qtyValue) : 0;

    const levels = levelsFor(s.depth, side);
    const walk = type === 'market' && q ? walkBook(levels, q) : null;
    const thin = walk !== null && walk.filled < q - 1e-12;
    const total = type === 'limit' ? p * q : walk?.cost ?? 0;
    const avg = walk && walk.filled ? walk.cost / walk.filled : 0;
    const short = side === 'buy' ? total > irt + 1e-9 : q > coin + 1e-12;

    const fillPercent = (pct: number) => {
        selection();
        setError(null);
        let amount = 0;
        if (side === 'sell') amount = (coin * pct) / 100;
        else if (type === 'limit') amount = p ? (irt * pct) / 100 / p : 0;
        else amount = qtyForCost(levels, ((irt * pct) / 100) * MARKET_BUY_HEADROOM);
        setQty(groupNumber(toAmount(amount, qtyDigits)));
    };

    const submit = async () => {
        if (busy) return;
        const problem = !qtyValue ? 'invalid_quantity'
            : type === 'limit' && !priceValue ? 'invalid_price'
                : type === 'market' && (!levels.length || thin) ? 'insufficient_liquidity'
                    : short ? 'insufficient_balance' : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const placed = await api.placeOrder({ symbol, side, type, quantity: qtyValue as string, ...(type === 'limit' ? { price: priceValue as string } : {}) });
            haptic('success');
            const o = placed.order;
            const filled = o ? Number(o.filled_quantity) : 0;
            if (o?.status === 'filled' || (type === 'market' && filled > 0)) {
                toast(t(side === 'buy' ? 'trade.bought' : 'trade.sold', { qty: fmtAsset(filled, base, { trim: true }), base }));
            } else {
                toast(t('trade.placed'));
            }
            setQty('');
            onPlaced(o);
        } catch (err) {
            haptic('error');
            setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="panel tf">
            <Segmented
                className="sides"
                value={side}
                onChange={setSide}
                options={[
                    { value: 'buy', label: t('trade.buy'), tone: 'buy' },
                    { value: 'sell', label: t('trade.sell'), tone: 'sell' },
                ]}
            />
            <div className="tf-types" role="tablist">
                {(['limit', 'market'] as OrderType[]).map((ty) => (
                    <button key={ty} type="button" role="tab" aria-selected={type === ty} className={type === ty ? 'active' : ''}
                            onClick={() => { selection(); setType(ty); setError(null); }}>
                        {t(`trade.${ty}`)}
                    </button>
                ))}
            </div>

            {type === 'limit' ? (
                <AmountInput
                    id="tf-price"
                    label={t('trade.price')}
                    value={price}
                    onChange={(v) => { setPrice(v); setPriceTouched(true); setError(null); }}
                    unit={t('common.toman')}
                    decimals={digits}
                    action={
                        <button type="button" className={`best-chip ${priceTouched ? '' : 'on'}`} onClick={() => { selection(); setPriceTouched(false); }}>
                            {side === 'buy' ? t('trade.bestAsk') : t('trade.bestBid')}
                        </button>
                    }
                    hint={!priceTouched && best ? t('trade.followsBest') : undefined}
                />
            ) : (
                <div className="tf-market-price">
                    <span>{t('trade.price')}</span>
                    <strong>{t('trade.marketPrice')}</strong>
                </div>
            )}

            <AmountInput
                id="tf-qty"
                label={t('trade.amount')}
                value={qty}
                onChange={(v) => { setQty(v); setError(null); }}
                unit={base}
                decimals={qtyDigits}
                invalid={short && q > 0}
            />

            <div className="tf-percents">
                {PERCENTS.map((pct) => (
                    <button key={pct} type="button" onClick={() => fillPercent(pct)}>{fmtPercentLabel(pct)}</button>
                ))}
            </div>

            <dl className="tf-summary">
                <div>
                    <dt>{t('trade.available')}</dt>
                    <dd>{side === 'buy' ? `${fmtToman(irt)} ${t('common.toman')}` : `${fmtAsset(coin, base, { floor: true })} ${base}`}</dd>
                </div>
                {type === 'market' && (
                    <div>
                        <dt>{t('trade.avgPrice')}</dt>
                        <dd>{avg ? `≈ ${fmtPrice(avg, digits)}` : '—'}</dd>
                    </div>
                )}
                <div>
                    <dt>{side === 'buy' ? t('trade.cost') : t('trade.proceeds')}</dt>
                    <dd className="strong">{total ? `${type === 'market' ? '≈ ' : ''}${fmtToman(total)} ${t('common.toman')}` : '—'}</dd>
                </div>
            </dl>

            {type === 'market' && <p className="tf-note">{thin ? t('trade.thin') : t('trade.marketNote')}</p>}
            {error && <p className="tf-error" role="alert">{errorMessage(error)}</p>}

            <button type="button" className={`button ${side}`} onClick={submit} disabled={busy} aria-busy={busy}>
                {busy && <Spinner small />}
                {t(side === 'buy' ? 'trade.submitBuy' : 'trade.submitSell', { base })}
            </button>
        </section>
    );
}

const fmtPercentLabel = (pct: number) => `${fmtAsset(pct, 'IRT')}٪`;

/** An ASCII amount grouped for an input, as typing it would show. */
function groupNumber(ascii: string): string {
    if (!ascii) return '';
    const [int, dec] = asciiNumber(ascii).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return dec ? `${grouped}.${dec}` : grouped;
}
