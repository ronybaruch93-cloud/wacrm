import { enUS, es, ko, pt } from "date-fns/locale";
import type { Locale } from "date-fns";

/**
 * date-fns locale matching the app locale (NEXT_PUBLIC_APP_LOCALE, the
 * same env var src/i18n/request.ts reads). Pass it to formatDistanceToNow
 * and friends so relative dates are not stuck in English.
 */
const LOCALES: Record<string, Locale> = { en: enUS, es, ko, pt };

export const dateLocale: Locale =
  LOCALES[process.env.NEXT_PUBLIC_APP_LOCALE || "en"] ?? enUS;

/** BCP-47 tag for Intl / toLocaleDateString. */
export const intlLocale = process.env.NEXT_PUBLIC_APP_LOCALE || "en";
