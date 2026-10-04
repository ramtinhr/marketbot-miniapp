import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type LedgerEntry } from '../api';
import { ArrowDownIcon, ArrowUpIcon, CandlesIcon, CreditCardIcon, RefreshIcon } from '../components/icons';
import { Alert, CoinIcon, Empty, PageHeader, Spinner, type Icon } from '../components/ui';
import { assetName, fmtAsset, fmtDateTime, fmtToman, num } from '../format';
import { t, type MessageKey } from '../i18n';
import { useNav } from '../nav';
import { balanceOf, refreshWallet, totalToman, useWallet } from '../wallet';

function QuickAction({ icon: I, label, onClick, disabled = false }: { icon: Icon; label: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button type="button" className="quick-action" onClick={onClick} disabled={disabled}>
            <span className="quick-action-icon"><I /></span>
            <span>{label}</span>
        </button>
    );
}

export function WalletPage() {
    const nav = useNav();
    const { info, error, loading } = useWallet();
    const total = totalToman(info);
    const irt = balanceOf(info, 'IRT');

    // Toman first, then what is held by its worth, then the rest.
    const rows = (info?.assets ?? []).map((asset) => {
        const b = balanceOf(info, asset);
        const amount = b.available + b.frozen;
        const worth = asset === 'IRT' ? amount : amount * (info?.prices[asset] ?? 0);
        return { asset, amount, worth };
    });
    rows.sort((a, b) => (a.asset === 'IRT' ? -1 : b.asset === 'IRT' ? 1 : b.worth - a.worth || b.amount - a.amount));

    return (
        <main className="screen tabbed enter">
            <section className="balance-card">
                <div className="balance-head">
                    <span>{t('wallet.total')}</span>
                    <button type="button" className="icon-button ghost" onClick={() => void refreshWallet()} aria-label={t('common.refresh')} disabled={loading}>
                        {loading ? <Spinner small /> : <RefreshIcon />}
                    </button>
                </div>
                <div className="balance-total">
                    <strong>{info ? fmtToman(total) : '—'}</strong>
                    <span>{t('common.toman')}</span>
                </div>
                <span className="balance-sub">{t('wallet.availableToman', { amount: fmtToman(irt.available) })}</span>
                <div className="quick-actions">
                    <QuickAction icon={CreditCardIcon} label={t('wallet.charge')} onClick={() => nav.push({ name: 'charge' })} />
                    <QuickAction icon={ArrowDownIcon} label={t('wallet.deposit')} onClick={() => nav.push({ name: 'deposit' })} />
                    <QuickAction icon={ArrowUpIcon} label={t('wallet.withdraw')} onClick={() => nav.push({ name: 'withdraw' })} />
                    <QuickAction icon={CandlesIcon} label={t('wallet.trade')} onClick={() => nav.openTrade()} />
                </div>
            </section>

            <Alert code={error} />

            <section>
                <h2 className="section-title">{t('wallet.assets')}</h2>
                {!info ? (
                    <ul className="section">{[0, 1, 2, 3].map((i) => <li key={i} className="row skeleton-row"><span className="skeleton circle" /><span className="skeleton line" /></li>)}</ul>
                ) : (
                    <ul className="section">
                        {rows.map(({ asset, amount, worth }) => (
                            <li key={asset}>
                                <button type="button" className={`row tappable ${amount ? '' : 'zero'}`} onClick={() => nav.push({ name: 'asset', asset })}>
                                    <CoinIcon asset={asset} />
                                    <span className="row-text">
                                        <span className="row-title">{assetName(asset)}</span>
                                        <span className="row-subtitle ltr-inline">{asset}</span>
                                    </span>
                                    <span className="row-end">
                                        <span className="row-amount">{fmtAsset(amount, asset, { floor: true, trim: asset !== 'IRT' })}</span>
                                        {asset !== 'IRT' && (
                                            <span className="row-subtitle">{worth ? t('wallet.worth', { amount: fmtToman(worth) }) : '—'}</span>
                                        )}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </main>
    );
}

/** A ledger line's name, from what moved and why. */
function entryLabel(e: LedgerEntry): MessageKey {
    const key = `entry.${e.kind}.${e.reference_type ?? ''}` as MessageKey;
    if (key in ENTRY_KEYS) return key;
    return (`entry.${e.kind}` in ENTRY_KEYS ? `entry.${e.kind}` : 'entry.other') as MessageKey;
}
const ENTRY_KEYS: Record<string, true> = Object.fromEntries(
    ['entry.credit.deposit', 'entry.freeze.withdrawal', 'entry.unfreeze.withdrawal', 'entry.debit.withdrawal',
        'entry.freeze.auction_order', 'entry.unfreeze.auction_order', 'entry.trade.auction_trade',
        'entry.lock', 'entry.unlock', 'entry.trade', 'entry.opening', 'entry.credit', 'entry.debit', 'entry.freeze', 'entry.unfreeze']
        .map((k) => [k, true]),
);

export function AssetPage({ asset }: { asset: string }) {
    const nav = useNav();
    const { info } = useWallet();
    const b = info?.balances.find((x) => x.asset === asset);
    const available = num(b?.available);
    const frozen = num(b?.frozen);
    const locked = num(b?.locked);
    const price = info?.prices[asset] ?? 0;

    const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
    const [next, setNext] = useState<number | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (before: number | null) => {
        try {
            const res = await api.entries(asset, before);
            setEntries((prev) => (before && prev ? [...prev, ...res.entries] : res.entries));
            setNext(res.next_before);
        } catch (err) {
            setError(err instanceof ApiError ? err.code : 'unknown');
        }
    }, [asset]);
    // A new balance means a new ledger line.
    useEffect(() => {
        void load(null);
    }, [load, b?.available, b?.frozen, b?.locked]);

    const fmt = (n: number) => fmtAsset(n, asset, { floor: true, trim: asset !== 'IRT' });

    return (
        <main className="screen enter">
            <PageHeader title={assetName(asset)} subtitle={asset} />

            <section className="asset-card">
                <CoinIcon asset={asset} size={52} />
                <div className="asset-total">
                    <strong>{fmt(available + frozen + locked)}</strong>
                    <span>{asset === 'IRT' ? t('common.toman') : asset}</span>
                </div>
                {asset !== 'IRT' && price > 0 && <span className="hint">{t('wallet.worth', { amount: fmtToman((available + frozen + locked) * price) })}</span>}
            </section>

            <ul className="section">
                <li className="row compact"><span className="row-title">{t('asset.available')}</span><span className="row-value strong">{fmt(available)}</span></li>
                <li className="row compact"><span className="row-title">{t('asset.inOrders')}</span><span className="row-value">{fmt(locked)}</span></li>
                <li className="row compact"><span className="row-title">{t('asset.inWithdrawals')}</span><span className="row-value">{fmt(frozen)}</span></li>
            </ul>

            <div className="button-row">
                {asset === 'IRT' ? (
                    <button type="button" className="button" onClick={() => nav.push({ name: 'charge' })}><CreditCardIcon />{t('wallet.charge')}</button>
                ) : (
                    <button type="button" className="button" onClick={() => nav.openTrade(`${asset}_IRT`)}><CandlesIcon />{t('asset.trade')}</button>
                )}
                <button type="button" className="button secondary" onClick={() => nav.push({ name: 'withdraw', asset })}><ArrowUpIcon />{t('wallet.withdraw')}</button>
            </div>

            <section>
                <h2 className="section-title">{t('asset.history')}</h2>
                <Alert code={error} />
                {entries === null ? (
                    <div className="center-pad"><Spinner /></div>
                ) : entries.length === 0 ? (
                    <Empty text={t('asset.noHistory')} />
                ) : (
                    <ul className="section">
                        {entries.map((e) => {
                            const delta = num(e.available_delta);
                            return (
                                <li key={e.id} className="row compact">
                                    <span className="row-text">
                                        <span className="row-title">{t(entryLabel(e))}</span>
                                        <span className="row-subtitle">{fmtDateTime(e.created_at)}</span>
                                    </span>
                                    <span className="row-end">
                                        <span className={`row-amount ${delta > 0 ? 'up' : ''}`}>
                                            <bdi className="ltr">{delta > 0 ? '+' : delta < 0 ? '−' : ''}{fmt(Math.abs(delta) || num(e.amount))}</bdi>
                                        </span>
                                        <span className="row-subtitle">{t('asset.after', { amount: fmt(num(e.available_after)) })}</span>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {next && (
                    <button type="button" className="link-button block" disabled={loadingMore}
                            onClick={async () => { setLoadingMore(true); await load(next); setLoadingMore(false); }}>
                        {loadingMore ? t('common.loading') : t('common.more')}
                    </button>
                )}
            </section>
        </main>
    );
}

export function DepositPage() {
    const nav = useNav();
    return (
        <main className="screen enter">
            <PageHeader title={t('deposit.title')} />
            <ul className="section">
                <li>
                    <button type="button" className="row tappable" onClick={() => nav.push({ name: 'charge' })}>
                        <CoinIcon asset="IRT" />
                        <span className="row-text">
                            <span className="row-title">{t('deposit.toman')}</span>
                            <span className="row-subtitle">{t('deposit.tomanBody')}</span>
                        </span>
                    </button>
                </li>
                <li className="row">
                    <CoinIcon asset="USDT" />
                    <span className="row-text">
                        <span className="row-title">{t('deposit.crypto')}</span>
                        <span className="row-subtitle">{t('deposit.cryptoBody')}</span>
                    </span>
                    <span className="pill">{t('common.soon')}</span>
                </li>
            </ul>
        </main>
    );
}
