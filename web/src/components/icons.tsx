import type { ReactNode, SVGProps } from 'react';

// Stroke icons on a 24px grid, drawn in currentColor so they take the
// surrounding text colour (and with it Telegram's theme).
function icon(paths: ReactNode) {
    return function Icon(props: SVGProps<SVGSVGElement>) {
        return (
            <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                {...props}
            >
                {paths}
            </svg>
        );
    };
}

export const SmartphoneIcon = icon(<><rect width="14" height="20" x="5" y="2" rx="3" /><path d="M11 18h2" /></>);
export const ShieldCheckIcon = icon(<><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>);
export const ZapIcon = icon(<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />);
export const MapPinIcon = icon(<><path d="M20 10c0 5-5.54 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.2 4 15 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>);
export const AlertIcon = icon(<><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>);
export const LockIcon = icon(<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>);
export const WifiOffIcon = icon(<><path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.18-2.65M19 12.86a10 10 0 0 0-2.29-1.62M22 8.82a15 15 0 0 0-11.29-3.76M5 12.86a10 10 0 0 1 5.17-2.7M2 2l20 20" /></>);
export const ClockIcon = icon(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
export const PhoneIcon = icon(<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />);
export const AtSignIcon = icon(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>);
export const CalendarIcon = icon(<><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>);
export const TrendingUpIcon = icon(<><path d="m22 7-8.5 8.5-5-5L2 17" /><path d="M16 7h6v6" /></>);
export const HomeIcon = icon(<><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>);
export const WalletIcon = icon(<><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>);
export const CandlesIcon = icon(<><path d="M9 5v4M9 15v4M15 3v4M15 13v6" /><rect width="4" height="6" x="7" y="9" rx="1" /><rect width="4" height="6" x="13" y="7" rx="1" /></>);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const ArrowDownIcon = icon(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
export const ArrowUpIcon = icon(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>);
export const CreditCardIcon = icon(<><rect width="20" height="14" x="2" y="5" rx="2" /><path d="M2 10h20" /></>);
export const ChevronStartIcon = icon(<path d="m9 18 6-6-6-6" />);
export const ChevronEndIcon = icon(<path d="m15 18-6-6 6-6" />);
export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />);
export const XIcon = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);
export const RefreshIcon = icon(<><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>);
export const SwapIcon = icon(<><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></>);
export const InboxIcon = icon(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>);
export const BankIcon = icon(<><path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7" /><path d="m12 2 8 5H4z" /></>);
export const MessageIcon = icon(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h8M8 13h5" /></>);
export const SendIcon = icon(<><path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z" /><path d="m21.85 2.15-10.94 10.94" /></>);
