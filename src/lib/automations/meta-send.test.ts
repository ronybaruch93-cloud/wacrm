import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared state for the fake service-role client. Hoisted so the vi.mock
// factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    templates: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function builder(table: string) {
    const ops = { type: "select", payload: undefined as unknown };
    const resolve = () => {
      if (table === "contacts") {
        return {
          data:
            ops.type === "update"
              ? null
              : { id: "c1", phone: "59899123456", wa_user_id: null },
          error: null,
        };
      }
      if (table === "whatsapp_config") {
        return {
          data: { phone_number_id: "pn1", access_token: "enc-token" },
          error: null,
        };
      }
      if (table === "message_templates") {
        return { data: state.templates, error: null };
      }
      if (table === "messages" && ops.type === "insert") {
        state.messages.push(ops.payload as Record<string, unknown>);
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: () => ((ops.type = "update"), b),
      eq: () => b,
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    };
    return b;
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) };
});

vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (s: string) => s }));

// meta-send pulls in the Flows senders for interactive messages; they
// are irrelevant here and would drag in their own dependencies.
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}));

import { engineSendTemplate } from "./meta-send";

const fetchMock = vi.fn();

/** The `template` object of the single request sent to Meta. */
function sentTemplate() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body).template as {
    name: string;
    language: { code: string };
    components?: Array<{ type: string; parameters: unknown[] }>;
  };
}

const IMAGE_TEMPLATE = {
  id: "t1",
  user_id: "u1",
  name: "order_ready",
  language: "es",
  category: "Utility",
  header_type: "image",
  header_media_url: "https://cdn.example.com/order.jpg",
  body_text: "Hola {{1}}, tu pedido está listo",
  created_at: "",
};

const BASE = {
  accountId: "acct-1",
  userId: "u1",
  conversationId: "conv-1",
  contactId: "c1",
  templateName: "order_ready",
};

beforeEach(() => {
  h.state.templates = [];
  h.state.messages = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engineSendTemplate — template components", () => {
  it("sends the media header of the template (Meta requires it on every send)", async () => {
    h.state.templates = [IMAGE_TEMPLATE];

    await engineSendTemplate({ ...BASE, language: "es", params: ["Ana"] });

    expect(sentTemplate().components).toEqual([
      {
        type: "header",
        parameters: [
          { type: "image", image: { link: "https://cdn.example.com/order.jpg" } },
        ],
      },
      { type: "body", parameters: [{ type: "text", text: "Ana" }] },
    ]);
  });

  it("lets a per-send header override replace the template's media", async () => {
    h.state.templates = [IMAGE_TEMPLATE];

    await engineSendTemplate({
      ...BASE,
      language: "es",
      params: ["Ana"],
      messageParams: { headerMediaUrl: "https://cdn.example.com/other.jpg" },
    });

    const header = sentTemplate().components?.[0] as {
      parameters: Array<{ image: { link: string } }>;
    };
    expect(header.parameters[0].image.link).toBe(
      "https://cdn.example.com/other.jpg",
    );
  });

  it("fills a TEXT header variable from messageParams", async () => {
    h.state.templates = [
      {
        ...IMAGE_TEMPLATE,
        header_type: "text",
        header_content: "Pedido {{1}}",
        header_media_url: undefined,
      },
    ];

    await engineSendTemplate({
      ...BASE,
      language: "es",
      params: ["Ana"],
      messageParams: { headerText: "#8523" },
    });

    expect(sentTemplate().components?.[0]).toEqual({
      type: "header",
      parameters: [{ type: "text", text: "#8523" }],
    });
  });

  it("still sends a body-only template when there is no local row", async () => {
    h.state.templates = [];

    await engineSendTemplate({ ...BASE, language: "es", params: ["Ana"] });

    expect(sentTemplate().components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ana" }] },
    ]);
  });
});

describe("engineSendTemplate — language and persistence", () => {
  it("falls back to the template's own language when none is configured", async () => {
    h.state.templates = [IMAGE_TEMPLATE];

    await engineSendTemplate({ ...BASE, language: "", params: ["Ana"] });

    expect(sentTemplate().language.code).toBe("es");
  });

  it("persists the rendered body of the template", async () => {
    h.state.templates = [IMAGE_TEMPLATE];

    await engineSendTemplate({ ...BASE, language: "es", params: ["Ana"] });

    expect(h.state.messages).toHaveLength(1);
    expect(h.state.messages[0]).toMatchObject({
      content_type: "template",
      content_text: "Hola Ana, tu pedido está listo",
      template_name: "order_ready",
      sender_type: "bot",
    });
  });
});

describe("engineSendTemplate — malformed template row", () => {
  it("fails with a clear message and never calls Meta", async () => {
    // Matches by name but lacks body_text, so it fails the shape guard.
    h.state.templates = [
      { id: "t1", user_id: "u1", name: "order_ready", language: "es" },
    ];

    await expect(
      engineSendTemplate({ ...BASE, language: "es", params: ["Ana"] }),
    ).rejects.toThrow(/malformed locally/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.messages).toHaveLength(0);
  });
});
