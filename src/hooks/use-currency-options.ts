"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useLocale } from "next-intl";

import {
  getCurrencyOptions,
  getCurrencyOptionsFor,
  type CurrencyOption,
} from "@/lib/currency";

const subscribe = () => () => {};

/**
 * Currencies for a picker, named in the app's language.
 *
 * `include` are the codes already chosen (the form's current value, the
 * account default…): they are always present, even if not a real ISO code.
 *
 * The full list comes from `Intl`, whose data varies with the ICU build of
 * the engine, so the server and the browser can disagree on it — React
 * would flag that as a hydration mismatch. So the server render and the
 * first browser render use only `include`, which is identical everywhere,
 * and the full list takes over once running in the browser.
 */
export function useCurrencyOptions(
  include: string[] = [],
): readonly CurrencyOption[] {
  const locale = useLocale();
  const key = include.join("|");
  const codes = useMemo(() => (key ? key.split("|") : []), [key]);

  const full = useMemo(
    () => getCurrencyOptions(locale, codes),
    [locale, codes],
  );
  const minimal = useMemo(
    () => getCurrencyOptionsFor(locale, codes),
    [locale, codes],
  );

  return useSyncExternalStore(
    subscribe,
    () => full,
    () => minimal,
  );
}
