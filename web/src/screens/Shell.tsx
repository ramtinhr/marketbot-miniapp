import type { User } from '../api';
import { CandlesIcon, HomeIcon, WalletIcon } from '../components/icons';
import { Toaster, type Icon } from '../components/ui';
import { t } from '../i18n';
import { NavProvider, useNav, type Page, type Tab } from '../nav';
import { UserContext } from '../user';
import { ChargePage } from './Charge';
import { Home } from './Screens';
import { TradePage } from './trade/Trade';
import { AssetPage, DepositPage, WalletPage } from './Wallet';
import { WithdrawPage } from './Withdraw';

const TABS: { tab: Tab; icon: Icon; label: 'tabs.home' | 'tabs.wallet' | 'tabs.trade' }[] = [
    { tab: 'home', icon: HomeIcon, label: 'tabs.home' },
    { tab: 'trade', icon: CandlesIcon, label: 'tabs.trade' },
    { tab: 'wallet', icon: WalletIcon, label: 'tabs.wallet' },
];

function TabBar() {
    const nav = useNav();
    return (
        <nav className="tabbar" aria-label={t('tabs.label')}>
            {TABS.map(({ tab, icon: I, label }) => (
                <button key={tab} type="button" className={nav.tab === tab ? 'active' : ''} aria-current={nav.tab === tab ? 'page' : undefined}
                        onClick={() => nav.setTab(tab)}>
                    <I />
                    <span>{t(label)}</span>
                </button>
            ))}
        </nav>
    );
}

function PageView({ page }: { page: Page }) {
    switch (page.name) {
        case 'asset': return <AssetPage asset={page.asset} />;
        case 'charge': return <ChargePage />;
        case 'deposit': return <DepositPage />;
        case 'withdraw': return <WithdrawPage initialAsset={page.asset} />;
    }
}

function Current({ user }: { user: User }) {
    const nav = useNav();
    const top = nav.stack.at(-1);
    if (top) return <PageView key={nav.stack.length} page={top} />;
    return (
        <>
            {nav.tab === 'home' && <Home user={user} />}
            {nav.tab === 'wallet' && <WalletPage />}
            {nav.tab === 'trade' && <TradePage />}
            <TabBar />
        </>
    );
}

/** The signed-in, SMS-verified app: three tabs and the pages opened from them. */
export function Shell({ user, initialTab, initialStack }: { user: User; initialTab?: Tab; initialStack?: Page[] }) {
    return (
        <UserContext.Provider value={user}>
            <NavProvider initialTab={initialTab} initialStack={initialStack}>
                <Current user={user} />
                <Toaster />
            </NavProvider>
        </UserContext.Provider>
    );
}
