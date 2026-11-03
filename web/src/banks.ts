// Bank codes/names: IR-Banks/ir-banks-info (MIT). See public/banks/NOTICE.md.
export interface BankBrand { name: string; logo?: string; base: string; tone: string; accent: string }
export const BANKS: Record<string, BankBrand> = {
    '010': { name: "بانک مرکزی جمهوری اسلامی ایران", logo: '/banks/Bank_Markazi.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '011': { name: "بانک صنعت و معدن", logo: '/banks/Sanat_Madan.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '012': { name: "بانک ملت", logo: '/banks/Mellat.svg', base: '#54152b', tone: '#db3554', accent: '#ff9a8b' },
    '013': { name: "بانک رفاه کارگران", logo: '/banks/Refah.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '014': { name: "بانک مسکن", logo: '/banks/Maskan.svg', base: '#6b2918', tone: '#d56831', accent: '#ffce90' },
    '015': { name: "بانک سپه", logo: '/banks/Sepah.svg', base: '#142d49', tone: '#395e9d', accent: '#ecac67' },
    '016': { name: "بانک کشاورزی", logo: '/banks/Keshavarzi.svg', base: '#123e31', tone: '#26835b', accent: '#c6dda3' },
    '017': { name: "بانک ملی ایران", logo: '/banks/Melli.svg', base: '#283d4f', tone: '#776d4e', accent: '#efd5a3' },
    '018': { name: "بانک تجارت", logo: '/banks/Tejarat.svg', base: '#093637', tone: '#187679', accent: '#a1d2c8' },
    '019': { name: "بانک صادرات ایران", logo: '/banks/Saderat.svg', base: '#101c52', tone: '#2856ad', accent: '#91b8f5' },
    '020': { name: "بانک توسعه صادرات", logo: '/banks/Tosee_Saderat.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '021': { name: "پست بانک ایران", logo: '/banks/Postbank.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '022': { name: "بانک توسعه تعاون", logo: '/banks/Tosee_Taavon.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '051': { name: "موسسه اعتباری توسعه", logo: '/banks/Tosee.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '052': { name: "بانک قوامین", logo: '/banks/Ghavamin.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '053': { name: "بانک کارآفرین", logo: '/banks/Karafarin.svg', base: '#113c30', tone: '#448568', accent: '#d2d594' },
    '054': { name: "بانک پارسیان", logo: '/banks/Parsian.svg', base: '#512221', tone: '#ae3838', accent: '#efc695' },
    '055': { name: "بانک اقتصاد نوین", logo: '/banks/Eghtesad_Novin.svg', base: '#301d49', tone: '#713d91', accent: '#d4b2e6' },
    '056': { name: "بانک سامان", logo: '/banks/Saman.svg', base: '#072f53', tone: '#168db2', accent: '#83e2ed' },
    '057': { name: "بانک پاسارگاد", logo: '/banks/Pasargad.svg', base: '#272123', tone: '#6a4930', accent: '#e3b76f' },
    '058': { name: "بانک سرمایه", logo: '/banks/Sarmayeh.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '059': { name: "بانک سینا", logo: '/banks/Sina.svg', base: '#1b355a', tone: '#536f99', accent: '#e2c18c' },
    '060': { name: "بانک مهر ایران", logo: '/banks/Mehr_Iran.svg', base: '#194332', tone: '#4e8f4d', accent: '#c6df96' },
    '061': { name: "بانک شهر", logo: '/banks/Shahr.svg', base: '#4a1525', tone: '#ad314c', accent: '#f394a8' },
    '062': { name: "بانک آینده", logo: '/banks/Ayandeh.svg', base: '#50351b', tone: '#9b722f', accent: '#f0d598' },
    '063': { name: "بانک انصار", logo: '/banks/Ansar.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '064': { name: "بانک گردشگری", logo: '/banks/Gardeshgari.svg', base: '#532a21', tone: '#b7673d', accent: '#f1c08a' },
    '065': { name: "بانک حکمت ایرانیان", logo: '/banks/Hekmat.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '066': { name: "بانک دی", logo: '/banks/Dey.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '069': { name: "بانک ایران زمین", logo: '/banks/Iran_Zamin.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '070': { name: "بانک قرض الحسنه رسالت", logo: '/banks/Resalat.svg', base: '#073e48', tone: '#148595', accent: '#9de0dd' },
    '073': { name: "موسسه اعتباری کوثر", logo: '/banks/Kosar.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '075': { name: "موسسه اعتباری ملل", logo: '/banks/Melall.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '078': { name: "بانک خاورمیانه", logo: '/banks/Khavar_Mianeh.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '080': { name: "موسسه اعتباری نور", logo: '/banks/Noor.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '079': { name: "بانک مهر اقتصاد", logo: '/banks/Mehr_Eghtesad.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
    '090': { name: "بانک مهر ایران", logo: '/banks/Mehr_Iran.svg', base: '#194332', tone: '#4e8f4d', accent: '#c6df96' },
    '095': { name: "بانک ایران و ونزوئلا", logo: '/banks/Iran_Venezuela.svg', base: '#193446', tone: '#3b7288', accent: '#b4d9e2' },
};
const UNKNOWN: BankBrand = { name: 'حساب بانکی', base: '#213344', tone: '#536b7c', accent: '#d0dee8' };

export function cleanIban(raw: string): string {
    const value = raw.replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
        .replace(/[\s-]/g, '').toUpperCase();
    return /^\d{24}$/.test(value) ? `IR${value}` : value;
}
export function bankFromIban(raw: string): BankBrand {
    const iban = cleanIban(raw);
    if (!/^IR\d{24}$/.test(iban) || BigInt(`${iban.slice(4)}1827${iban.slice(2, 4)}`) % 97n !== 1n) return UNKNOWN;
    return BANKS[iban.slice(4, 7)] ?? UNKNOWN;
}
export function formatIban(raw: string): string {
    return cleanIban(raw).match(/.{1,4}/g)?.join(' ') ?? '';
}
