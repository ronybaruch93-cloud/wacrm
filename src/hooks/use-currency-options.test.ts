import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "es" }));

import { useCurrencyOptions } from "./use-currency-options";

function Picker({ include }: { include: string[] }) {
  const options = useCurrencyOptions(include);
  return createElement(
    "select",
    null,
    options.map((o) =>
      createElement(
        "option",
        { key: o.code, value: o.code },
        `${o.code} ${o.label}`,
      ),
    ),
  );
}

const optionCount = (html: string) => (html.match(/<option/g) ?? []).length;

// renderToString uses the server snapshot, which is also what the browser
// renders first while hydrating. If it ever returned the full Intl list,
// a server and a browser with different ICU data would disagree on it.
describe("useCurrencyOptions — server render", () => {
  it("renders only the already-chosen currency, not the ICU-dependent full list", () => {
    const html = renderToString(createElement(Picker, { include: ["UYU"] }));

    expect(optionCount(html)).toBe(1);
    expect(html).toContain("UYU");
    expect(html).toMatch(/uruguayo/i);
  });

  it("renders each chosen code once", () => {
    const html = renderToString(
      createElement(Picker, { include: ["UYU", "USD", "UYU"] }),
    );

    expect(optionCount(html)).toBe(2);
  });

  it("keeps a chosen code that is not a real currency", () => {
    const html = renderToString(createElement(Picker, { include: ["QQQ"] }));

    expect(optionCount(html)).toBe(1);
    expect(html).toContain("QQQ");
  });

  it("renders no options when nothing is chosen", () => {
    expect(
      optionCount(renderToString(createElement(Picker, { include: [] }))),
    ).toBe(0);
  });
});
