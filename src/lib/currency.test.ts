import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CURRENCY,
  formatCurrency,
  formatCurrencyShort,
  getCurrencyName,
  getCurrencyOptions,
  getCurrencyOptionsFor,
  isIsoCurrency,
} from "./currency";

describe("formatCurrency", () => {
  it("formats whole amounts with no minor units", () => {
    // Use a non-breaking-space-tolerant check: Intl may insert NBSP.
    const out = formatCurrency(1234, "USD");
    expect(out).toContain("1,234");
    expect(out).not.toContain(".00");
  });

  it("defaults to USD when no currency is given", () => {
    expect(formatCurrency(10)).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("treats an empty-string currency as the default", () => {
    expect(formatCurrency(10, "")).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("coerces non-finite values to 0", () => {
    expect(formatCurrency(Number.NaN, "USD")).toContain("0");
  });

  it("renders a well-formed but unknown ISO code without throwing", () => {
    // Intl is lenient here — it uses the code as the symbol.
    const out = formatCurrency(1234, "ZZZ");
    expect(out).toContain("ZZZ");
    expect(out).toContain("1,234");
  });

  it("never throws on a structurally invalid code (no DB CHECK on deals.currency)", () => {
    for (const bad of ["United States", "US", "USDD", "12", "u$d"]) {
      expect(() => formatCurrency(1234, bad)).not.toThrow();
      expect(formatCurrency(1234, bad)).toContain("1,234");
    }
  });

  it("formats every offered currency without throwing", () => {
    for (const c of getCurrencyOptions("en")) {
      expect(() => formatCurrency(1000, c.code)).not.toThrow();
    }
  });
});

describe("formatCurrencyShort", () => {
  it("abbreviates millions and thousands with the currency symbol", () => {
    expect(formatCurrencyShort(2_500_000, "USD")).toBe("$2.5M");
    expect(formatCurrencyShort(3_400, "USD")).toBe("$3.4k");
    expect(formatCurrencyShort(900, "USD")).toBe("$900");
  });

  it("uses the matching symbol for non-USD currencies", () => {
    expect(formatCurrencyShort(1_000, "EUR")).toBe("€1.0k");
    expect(formatCurrencyShort(1_000, "INR")).toBe("₹1.0k");
  });

  it("falls back to the code prefix for unknown currencies (no throw)", () => {
    expect(formatCurrencyShort(1_000, "ZZZ")).toBe("ZZZ 1.0k");
  });

  // The symbols the old fixed list carried must not change: moving the
  // pickers to Intl is not allowed to alter how existing amounts look.
  it.each([
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
  ])("keeps the symbol of %s as %s", (code, symbol) => {
    expect(formatCurrencyShort(1_000, code)).toBe(`${symbol}1.0k`);
  });

  it("shows the Uruguayan peso with its own symbol", () => {
    expect(formatCurrencyShort(1_000, "UYU")).toBe("$U1.0k");
  });

  it("never resolves a code to something inherited from Object.prototype", () => {
    expect(formatCurrencyShort(1_000, "constructor")).toBe("constructor 1.0k");
    expect(formatCurrencyShort(1_000, "__proto__")).toBe("__proto__ 1.0k");
  });
});

describe("getCurrencyOptions", () => {
  it("offers currencies the old fixed list did not, starting with the peso uruguayo", () => {
    const codes = getCurrencyOptions("en").map((o) => o.code);
    for (const code of ["UYU", "ARS", "CLP", "PEN", "PYG"]) {
      expect(codes).toContain(code);
    }
  });

  it("pins the common currencies first, in a fixed order", () => {
    const codes = getCurrencyOptions("en").map((o) => o.code);
    expect(codes.slice(0, 5)).toEqual(["USD", "UYU", "ARS", "BRL", "EUR"]);
  });

  it("sorts the rest by name in the app's language", () => {
    const rest = getCurrencyOptions("es").slice(5).map((o) => o.label);
    const sorted = [...rest].sort((a, b) => a.localeCompare(b, "es"));
    expect(rest).toEqual(sorted);
  });

  it("has no duplicate codes", () => {
    const codes = getCurrencyOptions("en").map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("names currencies in the requested language", () => {
    const label = (locale: string) =>
      getCurrencyOptions(locale).find((o) => o.code === "UYU")?.label;
    expect(label("en")).toMatch(/Uruguayan/i);
    expect(label("es")).toMatch(/uruguayo/i);
  });

  it("keeps a held code that is not a real currency, first and unduplicated", () => {
    const options = getCurrencyOptions("en", ["QQQ", "USD", "QQQ"]);
    expect(options[0]).toEqual({ code: "QQQ", label: "QQQ" });
    expect(options.filter((o) => o.code === "QQQ")).toHaveLength(1);
    expect(options.filter((o) => o.code === "USD")).toHaveLength(1);
  });

  it("ignores blank held codes", () => {
    const base = getCurrencyOptions("en");
    expect(getCurrencyOptions("en", ["", ""]).length).toBe(base.length);
  });

  it("is computed once per locale", () => {
    expect(getCurrencyOptions("pt")).toBe(getCurrencyOptions("pt"));
  });

  it("survives a malformed locale instead of breaking the page", () => {
    expect(() => getCurrencyOptions("not a locale")).not.toThrow();
    expect(getCurrencyOptions("not a locale").length).toBeGreaterThan(100);
  });
});

describe("getCurrencyOptionsFor", () => {
  it("returns exactly the codes asked for, named in the locale, without duplicates", () => {
    expect(getCurrencyOptionsFor("es", ["UYU", "USD", "UYU", ""])).toEqual([
      { code: "UYU", label: getCurrencyName("UYU", "es") },
      { code: "USD", label: getCurrencyName("USD", "es") },
    ]);
  });

  it("falls back to the code for something that is not a currency", () => {
    expect(getCurrencyOptionsFor("en", ["United States"])).toEqual([
      { code: "United States", label: "United States" },
    ]);
  });
});

describe("getCurrencyName", () => {
  it("names a currency in the given language", () => {
    expect(getCurrencyName("UYU", "es")).toMatch(/uruguayo/i);
  });

  it("returns the code itself when it cannot name it", () => {
    expect(getCurrencyName("ZZZ")).toBe("ZZZ");
    expect(getCurrencyName("not a code")).toBe("not a code");
  });
});

describe("isIsoCurrency", () => {
  it.each(["UYU", "USD", "ARS", "JPY"])("accepts %s", (code) => {
    expect(isIsoCurrency(code)).toBe(true);
  });

  it.each(["ZZZ", "U1", "usd", "", "USDD", "$"])("rejects %j", (code) => {
    expect(isIsoCurrency(code)).toBe(false);
  });

  it("every currency a picker offers is one the API accepts", () => {
    for (const { code } of getCurrencyOptions("en")) {
      expect(isIsoCurrency(code)).toBe(true);
    }
  });
});

describe("a runtime without Intl.supportedValuesOf", () => {
  const original = Intl.supportedValuesOf;
  const remove = () =>
    Object.defineProperty(Intl, "supportedValuesOf", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  afterEach(() => {
    Object.defineProperty(Intl, "supportedValuesOf", {
      value: original,
      configurable: true,
      writable: true,
    });
  });

  it("still offers the pinned currencies instead of an empty picker", () => {
    remove();
    // A locale no other test uses: the result is cached per locale.
    const codes = getCurrencyOptions("de").map((o) => o.code);
    expect(codes).toEqual(["USD", "UYU", "ARS", "BRL", "EUR"]);
  });

  it("falls back to the shape check instead of rejecting everything", () => {
    remove();
    expect(isIsoCurrency("UYU")).toBe(true);
    expect(isIsoCurrency("u1")).toBe(false);
  });
});
