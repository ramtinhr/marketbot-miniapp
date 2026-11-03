import type { CSSProperties } from 'react';
import type { BankAccount } from '../api';
import { bankFromIban, formatIban } from '../banks';
import { t } from '../i18n';
import { BankIcon, CheckIcon } from './icons';

type Account = Pick<BankAccount, 'iban' | 'holder_name' | 'label'>;

/** A bank-branded account card; the Sheba identifies the bank locally. */
export function BankCard({ account, compact = false, selected = false }: { account: Account; compact?: boolean; selected?: boolean }) {
    const bank = bankFromIban(account.iban);
    const style = { '--bank-base': bank.base, '--bank-tone': bank.tone, '--bank-accent': bank.accent } as CSSProperties;
    return <div className={`bank-card${compact ? ' bank-card-compact' : ''}${selected ? ' bank-card-selected' : ''}`} style={style}>
        <div className="bank-card-pattern" aria-hidden="true" />
        <div className="bank-card-top">
            <span className="bank-card-logo">{bank.logo ? <img src={bank.logo} alt="" width={36} height={36} /> : <BankIcon />}</span>
            <span className="bank-card-heading"><strong>{bank.name}</strong><span>{account.label || t('banks.title')}</span></span>
            {selected && <span className="bank-card-check"><CheckIcon /></span>}
        </div>
        <div className="bank-card-number"><span>{t('banks.iban')}</span><bdi dir="ltr">{formatIban(account.iban)}</bdi></div>
        <div className="bank-card-bottom"><span>{account.holder_name || t('banks.holder')}</span><span className="bank-card-mark" aria-hidden="true">IR / IBAN</span></div>
    </div>;
}
