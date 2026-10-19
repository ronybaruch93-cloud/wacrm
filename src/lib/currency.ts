/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "USD";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Name for the dropdown, in the app's language, e.g. "US Dollar". */
  label: string;
}

/**
 * Listed first in pickers. This only affects ORDER, never availability:
 * every real ISO-4217 currency is offered, because the list comes from
 * `Intl` — so a new currency needs no code change and no migration.
 */
const PINNED_CODES = ["USD", "UYU", "ARS", "BRL", "EUR"];

/**
 * Symbols for the compact format ("$1.2M"). Purely cosmetic: a currency
 * that is not here is still fully supported and simply shows its code
 * ("UYU 1.2k"). Kept as a Map so a code like "constructor" can't resolve
 * to something inherited from Object.prototype.
 */
const COMPACT_SYMBOLS = new Map<string, string>([
  ["USD", "$"],
  ["EUR", "€"],
  ["GBP", "£"],
  ["INR", "₹"],
  ["AUD", "A$"],
  ["CAD", "C$"],
  ["BRL", "R$"],
  ["JPY", "¥"],
  ["CNY", "¥"],
  ["AED", "د.إ"],
  ["ZAR", "R"],
  ["NGN", "₦"],
  ["SGD", "S$"],
  ["MXN", "$"],
  ["COP", "$"],
  ["UYU", "$U"],
]);

/** Every ISO-4217 code the runtime knows; the pinned few if it can't say. */
function supportedCurrencyCodes(): string[] {
  try {
    const codes = Intl.supportedValuesOf("currency");
    if (codes.length > 0) return codes;
  } catch {
    // Runtime without Intl.supportedValuesOf — fall through.
  }
  return PINNED_CODES;
}

/**
 * Whether `code` (upper-case, 3 letters) is a real ISO-4217 currency.
 * The schema deliberately accepts any 3-letter code, so this is what the
 * public API checks to refuse made-up ones — and it is the same list the
 * pickers offer, so the two can never disagree. If a runtime cannot list
 * currencies, the shape check alone applies rather than rejecting all.
 */
export function isIsoCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    return Intl.supportedValuesOf("currency").includes(code);
  } catch {
    return true;
  }
}

/** A locale `Intl` accepts, or "en" — a bad tag must never break a render. */
function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    return "en";
  }
}

function currencyNames(locale: string): Intl.DisplayNames | null {
  for (const l of [safeLocale(locale), "en"]) {
    try {
      return new Intl.DisplayNames([l], { type: "currency" });
    } catch {
      // try the next one
    }
  }
  return null;
}

/** "Uruguayan Peso" / "peso uruguayo" — the code itself if unknown. */
export function getCurrencyName(code: string, locale: string = "en"): string {
  try {
    return currencyNames(locale)?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Options for exactly `codes`, named in `locale`. The full list depends on
 * the ICU build of the JavaScript engine, which can differ between the
 * server and the browser; a handful of already-chosen codes does not. This
 * is what a picker renders until it is running in the browser.
 */
export function getCurrencyOptionsFor(
  locale: string,
  codes: string[],
): CurrencyOption[] {
  return [...new Set(codes)]
    .filter(Boolean)
    .map((code) => ({ code, label: getCurrencyName(code, locale) }));
}

const optionsCache = new Map<string, CurrencyOption[]>();

function buildCurrencyOptions(locale: string): CurrencyOption[] {
  const names = currencyNames(locale);
  const labelOf = (code: string) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };

  const all = supportedCurrencyCodes().map((code) => ({
    code,
    label: labelOf(code),
  }));
  const pinned = PINNED_CODES.flatMap((code) => {
    const found = all.find((o) => o.code === code);
    return found ? [found] : [];
  });
  const rest = all
    .filter((o) => !PINNED_CODES.includes(o.code))
    .sort((a, b) => a.label.localeCompare(b.label, safeLocale(locale)));
  return [...pinned, ...rest];
}

/**
 * The currencies offered in pickers, named in `locale`. `include` lists
 * codes that must appear even if they are not real ISO codes — the value a
 * form already holds (legacy rows can carry anything, `deals.currency` has
 * no DB CHECK) — so a select never silently drops what is selected.
 */
export function getCurrencyOptions(
  locale: string = "en",
  include: string[] = [],
): readonly CurrencyOption[] {
  const key = safeLocale(locale);
  let base = optionsCache.get(key);
  if (!base) {
    base = buildCurrencyOptions(key);
    optionsCache.set(key, base);
  }
  const missing = [...new Set(include)].filter(
    (code) => code && !base.some((o) => o.code === code),
  );
  return missing.length > 0
    ? [...missing.map((code) => ({ code, label: code })), ...base]
    : base;
}

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) — deal values are tracked to the dollar across
 * the app. `currency` defaults to USD so callers with nothing better
 * stay safe, but pass the account/deal currency wherever known.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "₹900". Uses the currency's symbol from
 * COMPACT_SYMBOLS, falling back to the code when we don't carry one.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = COMPACT_SYMBOLS.get(code) ?? `${code} `;
  return `${symbol}${formatCompactNumber(value)}`;
}

/**
 * Compact number for tight spaces (chart tiles, legends): 1_234 → "1.2k",
 * 1_200_000 → "1.2M", 900 → "900". The unit-less core shared with
 * {@link formatCurrencyShort}.
 */
export function formatCompactNumber(value: number): string {
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
