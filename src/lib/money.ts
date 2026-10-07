export interface CurrencyFormat {
  code: string;
  symbol: string;
  locale: string;
}

/** 54999 + INR -> "₹54,999"; 101500 -> "₹1,01,500" (Indian grouping via the currency's locale). */
export function formatMoney(amount: number, currency: CurrencyFormat) {
  const number = new Intl.NumberFormat(currency.locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  return `${currency.symbol}${number}`;
}

/** Plain-text version for messages (WhatsApp, email), where codes read more clearly than symbols: "AED 2,450". */
export function formatMoneyCode(amount: number, currency: CurrencyFormat) {
  const number = new Intl.NumberFormat(currency.locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  return `${currency.code} ${number}`;
}
