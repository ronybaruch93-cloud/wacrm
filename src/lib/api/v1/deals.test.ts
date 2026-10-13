import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('./contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contacts')>();
  return {
    ...actual,
    findOrCreateContact: vi.fn(),
    resolveAuditUserId: vi.fn(),
  };
});

import {
  ContactError,
  findOrCreateContact,
  resolveAuditUserId,
} from './contacts';
import {
  createDeal,
  getDealById,
  parseCreateDeal,
  serializeDeal,
  type CreateDealInput,
} from './deals';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

// ---------- parseCreateDeal ----------

const VALID = {
  contact: { phone: '+59899123456', name: 'Ana' },
  pipeline_id: UUID_A,
  title: '#VTX8523',
};

describe('parseCreateDeal — accepts', () => {
  it('a minimal deal, applying defaults', () => {
    expect(parseCreateDeal(VALID)).toEqual({
      contact: { kind: 'phone', phone: '+59899123456', name: 'Ana' },
      pipelineId: UUID_A,
      stageId: undefined,
      title: '#VTX8523',
      value: 0,
      currency: undefined,
      notes: null,
      expectedCloseDate: null,
      details: {},
      fields: {},
      externalId: null,
    });
  });

  it('a full deal', () => {
    const input = parseCreateDeal({
      contact_id: UUID_B,
      stage_id: UUID_A,
      title: '  Pedido  ',
      value: 1500.5,
      currency: 'uyu',
      notes: 'Entregar por la tarde',
      expected_close_date: '2026-12-31',
      details: { items: [{ sku: 'A1', qty: 2 }] },
      fields: { 'Fecha límite': '2026-12-24', talle: 'M', paid: true, n: 3 },
      external_id: 'ord-1001',
    });

    expect(input.contact).toEqual({ kind: 'id', id: UUID_B });
    expect(input.title).toBe('Pedido');
    expect(input.currency).toBe('UYU');
    expect(input.fields).toEqual({
      fecha_limite: '2026-12-24',
      talle: 'M',
      paid: 'true',
      n: '3',
    });
    expect(input.details).toEqual({ items: [{ sku: 'A1', qty: 2 }] });
    expect(input.externalId).toBe('ord-1001');
  });

  it.each(['UYU', 'ARS', 'usd', 'clp'])(
    'any real ISO currency, not only the ones in the picker (%s)',
    (code) => {
      expect(parseCreateDeal({ ...VALID, currency: code }).currency).toBe(
        code.toUpperCase()
      );
    }
  );

  it('drops blank and null field values instead of storing them', () => {
    const input = parseCreateDeal({
      ...VALID,
      fields: { talle: '   ', color: null, marca: 'X' },
    });

    expect(input.fields).toEqual({ marca: 'X' });
  });
});

describe('parseCreateDeal — rejects', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['a body that is not an object', 'hola', /JSON object/],
    ['an array body', [], /JSON object/],
    [
      'an unknown top-level field (typo)',
      { ...VALID, valor: 10 },
      /Unknown field.*valor/,
    ],
    [
      'neither contact nor contact_id',
      { pipeline_id: UUID_A, title: 'x' },
      /exactly one/,
    ],
    [
      'both contact and contact_id',
      { ...VALID, contact_id: UUID_B },
      /exactly one/,
    ],
    [
      'a contact without phone',
      { ...VALID, contact: { name: 'Ana' } },
      /contact\.phone/,
    ],
    [
      'an unknown contact field',
      { ...VALID, contact: { phone: '+598', age: 3 } },
      /Unknown contact field/,
    ],
    [
      'a malformed contact_id',
      { ...VALID, contact: undefined, contact_id: 'abc' },
      /contact_id/,
    ],
    [
      'neither pipeline_id nor stage_id',
      { contact: VALID.contact, title: 'x' },
      /pipeline_id/,
    ],
    [
      'a malformed pipeline_id',
      { ...VALID, pipeline_id: 'nope' },
      /pipeline_id/,
    ],
    ['a missing title', { ...VALID, title: undefined }, /title/],
    ['a blank title', { ...VALID, title: '   ' }, /title/],
    [
      'a title over 200 characters',
      { ...VALID, title: 'x'.repeat(201) },
      /at most 200/,
    ],
    ['a non-numeric value', { ...VALID, value: '10' }, /number/],
    ['a negative value', { ...VALID, value: -1 }, /between 0/],
    ['a value beyond NUMERIC(12,2)', { ...VALID, value: 1e12 }, /between 0/],
    [
      'a value with more than 2 decimals',
      { ...VALID, value: 10.123 },
      /2 decimal/,
    ],
    [
      'a currency that is not a real ISO code',
      { ...VALID, currency: 'ZZZ' },
      /valid ISO 4217/,
    ],
    [
      'a currency with the wrong shape',
      { ...VALID, currency: 'U1' },
      /valid ISO 4217/,
    ],
    [
      'an impossible date',
      { ...VALID, expected_close_date: '2026-02-30' },
      /valid date/,
    ],
    [
      'a date in the wrong format',
      { ...VALID, expected_close_date: '31/12/2026' },
      /valid date/,
    ],
    ['details that are an array', { ...VALID, details: [1] }, /JSON object/],
    [
      'details over 32 KB',
      { ...VALID, details: { blob: 'x'.repeat(33 * 1024) } },
      /32 KB/,
    ],
    [
      'fields that are an array',
      { ...VALID, fields: ['a'] },
      /'fields' must be an object/,
    ],
    [
      'a field value that is an object',
      { ...VALID, fields: { a: { b: 1 } } },
      /text, a number/,
    ],
    [
      'two field names that normalise to the same key',
      { ...VALID, fields: { 'Fecha Límite': 'a', fecha_limite: 'b' } },
      /two entries/,
    ],
    [
      'a field name with nothing usable',
      { ...VALID, fields: { '!!!': 'a' } },
      /invalid name/,
    ],
    [
      'an empty external_id',
      { ...VALID, external_id: '  ' },
      /must not be empty/,
    ],
    [
      'an external_id over 200 characters',
      { ...VALID, external_id: 'x'.repeat(201) },
      /at most 200/,
    ],
  ];

  it.each(cases)('%s', (_name, body, message) => {
    expect(() => parseCreateDeal(body)).toThrow(message);
    try {
      parseCreateDeal(body);
    } catch (err) {
      // Every validation failure must reach the client as a 400.
      expect(err).toMatchObject({ code: 'bad_request', status: 400 });
    }
  });
});

// ---------- serializeDeal ----------

describe('serializeDeal', () => {
  const ROW = {
    id: 'd1',
    external_id: 'ord-1',
    title: 'Pedido',
    value: '1500.00',
    currency: 'UYU',
    status: 'open',
    notes: null,
    expected_close_date: null,
    details: { sku: 'A1' },
    pipeline_id: 'p1',
    created_at: 't1',
    updated_at: 't2',
    // Columns that must not leak onto the public wire.
    account_id: 'acct-1',
    user_id: 'u1',
    stage: { id: 's1', name: 'Nuevo' },
    contact: [{ id: 'c1', name: 'Ana', phone: '+59899123456' }],
    deal_custom_values: [
      { value: 'M', field: { field_name: 'Talle' } },
      { value: '2026-12-24', field: [{ field_name: 'Fecha límite' }] },
    ],
  };

  it('returns the documented shape and nothing else', () => {
    expect(serializeDeal(ROW)).toEqual({
      id: 'd1',
      external_id: 'ord-1',
      title: 'Pedido',
      value: 1500,
      currency: 'UYU',
      status: 'open',
      notes: null,
      expected_close_date: null,
      details: { sku: 'A1' },
      fields: { talle: 'M', fecha_limite: '2026-12-24' },
      pipeline_id: 'p1',
      stage: { id: 's1', name: 'Nuevo' },
      contact: { id: 'c1', name: 'Ana', phone: '+59899123456' },
      created_at: 't1',
      updated_at: 't2',
    });
  });

  it('tolerates a deal whose contact was deleted', () => {
    expect(serializeDeal({ ...ROW, contact: null }).contact).toBeNull();
  });
});

// ---------- createDeal ----------

interface Q {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
  payload?: unknown;
}

interface World {
  contact: unknown;
  pipeline: unknown;
  firstStage: unknown;
  stageById: unknown;
  customFields: unknown[];
  accountCurrency: string;
  /** Results of successive `deals` lookups by external_id. */
  externalLookups: unknown[];
  insertResult: { data: unknown; error: unknown };
  valuesError: unknown;
  dealRow: Record<string, unknown>;
}

const DEAL_ROW = {
  id: 'd1',
  external_id: 'ord-1',
  title: 'Pedido',
  value: '1500.00',
  currency: 'UYU',
  status: 'open',
  notes: null,
  expected_close_date: null,
  details: {},
  pipeline_id: 'p1',
  created_at: 't1',
  updated_at: 't2',
  stage: { id: 's-first', name: 'Nuevo' },
  contact: { id: 'c1', name: 'Ana', phone: '+59899123456' },
  deal_custom_values: [],
};

function makeWorld(over: Partial<World> = {}): World {
  return {
    contact: { id: 'c1' },
    pipeline: { id: 'p1' },
    firstStage: { id: 's-first' },
    stageById: { id: 's-given', pipeline_id: 'p1' },
    customFields: [],
    accountCurrency: 'UYU',
    externalLookups: [null],
    insertResult: { data: { id: 'd1' }, error: null },
    valuesError: null,
    dealRow: DEAL_ROW,
    ...over,
  };
}

function makeDb(world: World) {
  const queries: Q[] = [];
  const hasFilter = (q: Q, col: string) => q.filters.some(([c]) => c === col);

  function respond(q: Q): { data: unknown; error: unknown } {
    switch (q.table) {
      case 'contacts':
        return { data: world.contact, error: null };
      case 'pipelines':
        return { data: world.pipeline, error: null };
      case 'pipeline_stages':
        return {
          data: hasFilter(q, 'id') ? world.stageById : world.firstStage,
          error: null,
        };
      case 'custom_fields':
        return { data: world.customFields, error: null };
      case 'accounts':
        return {
          data: { default_currency: world.accountCurrency },
          error: null,
        };
      case 'deal_custom_values':
        return { data: null, error: world.valuesError };
      case 'deals':
        if (q.op === 'insert') return world.insertResult;
        if (q.op === 'delete') return { data: null, error: null };
        if (hasFilter(q, 'external_id')) {
          return { data: world.externalLookups.shift() ?? null, error: null };
        }
        return { data: world.dealRow, error: null };
      default:
        return { data: null, error: null };
    }
  }

  const db = {
    from(table: string) {
      const q: Q = { table, op: 'select', filters: [] };
      const run = () => {
        queries.push(q);
        return Promise.resolve(respond(q));
      };
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: unknown) => ((q.op = 'insert'), (q.payload = p), b),
        delete: () => ((q.op = 'delete'), b),
        eq: (c: string, v: unknown) => (q.filters.push([c, v]), b),
        order: () => b,
        limit: () => b,
        single: run,
        maybeSingle: run,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          run().then(f, r),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const INPUT: CreateDealInput = {
  contact: { kind: 'id', id: UUID_B },
  pipelineId: 'p1',
  stageId: undefined,
  title: 'Pedido',
  value: 1500,
  currency: undefined,
  notes: null,
  expectedCloseDate: null,
  details: { items: [] },
  fields: {},
  externalId: 'ord-1',
};

const inserts = (queries: Q[], table: string) =>
  queries.filter((q) => q.table === table && q.op === 'insert');

beforeEach(() => {
  vi.mocked(findOrCreateContact).mockReset();
  vi.mocked(resolveAuditUserId).mockReset();
  vi.mocked(resolveAuditUserId).mockResolvedValue('audit-user');
  vi.mocked(findOrCreateContact).mockResolvedValue({
    id: 'c-phone',
    created: true,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('createDeal — happy path', () => {
  it('inserts the deal in the first stage with the account defaults', async () => {
    const { db, queries } = makeDb(makeWorld());

    const { deal, created } = await createDeal(db, 'acct-1', INPUT);

    expect(created).toBe(true);
    expect(inserts(queries, 'deals')[0].payload).toEqual({
      account_id: 'acct-1',
      user_id: 'audit-user',
      contact_id: 'c1',
      pipeline_id: 'p1',
      stage_id: 's-first',
      title: 'Pedido',
      value: 1500,
      currency: 'UYU',
      status: 'open',
      notes: null,
      expected_close_date: null,
      details: { items: [] },
      external_id: 'ord-1',
    });
    expect(deal.id).toBe('d1');
    expect(deal.value).toBe(1500);
  });

  it('uses an explicit currency instead of the account default', async () => {
    const { db, queries } = makeDb(makeWorld());

    await createDeal(db, 'acct-1', { ...INPUT, currency: 'USD' });

    expect(
      (inserts(queries, 'deals')[0].payload as { currency: string }).currency
    ).toBe('USD');
    expect(queries.some((q) => q.table === 'accounts')).toBe(false);
  });

  it('finds or creates the contact when given a phone', async () => {
    const { db, queries } = makeDb(makeWorld());

    await createDeal(db, 'acct-1', {
      ...INPUT,
      contact: { kind: 'phone', phone: '+59899123456', name: 'Ana' },
    });

    expect(findOrCreateContact).toHaveBeenCalledWith(
      db,
      'acct-1',
      'audit-user',
      {
        phone: '+59899123456',
        name: 'Ana',
        email: undefined,
        company: undefined,
      }
    );
    expect(
      (inserts(queries, 'deals')[0].payload as { contact_id: string })
        .contact_id
    ).toBe('c-phone');
  });

  it("stores normalised fields against this account's deal-field ids", async () => {
    const { db, queries } = makeDb(
      makeWorld({
        customFields: [
          { id: 'f1', field_name: 'Fecha límite' },
          { id: 'f2', field_name: 'Talle' },
        ],
      })
    );

    await createDeal(db, 'acct-1', {
      ...INPUT,
      fields: { fecha_limite: '2026-12-24', talle: 'M' },
    });

    expect(inserts(queries, 'deal_custom_values')[0].payload).toEqual([
      { deal_id: 'd1', custom_field_id: 'f1', value: '2026-12-24' },
      { deal_id: 'd1', custom_field_id: 'f2', value: 'M' },
    ]);
    // Only the account's DEAL fields may be matched.
    const lookup = queries.find((q) => q.table === 'custom_fields');
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ['account_id', 'acct-1'],
        ['entity_type', 'deal'],
      ])
    );
  });
});

describe('createDeal — reading the result back', () => {
  it('scopes the read of the created deal to the account', async () => {
    const { db, queries } = makeDb(makeWorld());

    await createDeal(db, 'acct-1', { ...INPUT, externalId: null });

    // The service-role client bypasses RLS: without this filter a deal id
    // from another account would be readable.
    const read = queries.find(
      (q) =>
        q.table === 'deals' &&
        q.op === 'select' &&
        q.filters.some(([c, v]) => c === 'id' && v === 'd1')
    );
    expect(read?.filters).toEqual(
      expect.arrayContaining([
        ['id', 'd1'],
        ['account_id', 'acct-1'],
      ])
    );
  });
});

describe('getDealById', () => {
  it('scopes the lookup to the account', async () => {
    const { db, queries } = makeDb(makeWorld());

    const deal = await getDealById(db, 'acct-1', 'd1');

    expect(deal?.id).toBe('d1');
    expect(queries[0].filters).toEqual([
      ['id', 'd1'],
      ['account_id', 'acct-1'],
    ]);
  });

  it('returns null for a deal that is not visible to the account', async () => {
    const { db } = makeDb(makeWorld({ dealRow: null as never }));

    expect(await getDealById(db, 'acct-1', 'other')).toBeNull();
  });
});

describe('createDeal — placement', () => {
  it('scopes a given stage to the account through its pipeline', async () => {
    const { db, queries } = makeDb(makeWorld());

    await createDeal(db, 'acct-1', {
      ...INPUT,
      pipelineId: undefined,
      stageId: 's-given',
    });

    const stageLookup = queries.find((q) => q.table === 'pipeline_stages');
    expect(stageLookup?.filters).toEqual(
      expect.arrayContaining([
        ['id', 's-given'],
        ['pipelines.account_id', 'acct-1'],
      ])
    );
    const payload = inserts(queries, 'deals')[0].payload as {
      stage_id: string;
      pipeline_id: string;
    };
    expect(payload.stage_id).toBe('s-given');
    expect(payload.pipeline_id).toBe('p1');
  });

  it('rejects a stage that is not in the given pipeline', async () => {
    const { db, queries } = makeDb(makeWorld());

    await expect(
      createDeal(db, 'acct-1', {
        ...INPUT,
        pipelineId: 'other',
        stageId: 's-given',
      })
    ).rejects.toMatchObject({ status: 400, message: /does not belong/ });
    expect(inserts(queries, 'deals')).toHaveLength(0);
  });

  it.each([
    [
      'an unknown stage',
      { stageById: null },
      { pipelineId: undefined, stageId: 'x' },
    ],
    ['an unknown pipeline', { pipeline: null }, {}],
    ['a pipeline with no stages', { firstStage: null }, {}],
  ])('rejects %s without writing anything', async (_n, world, input) => {
    const { db, queries } = makeDb(makeWorld(world));

    await expect(
      createDeal(db, 'acct-1', { ...INPUT, ...input })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(inserts(queries, 'deals')).toHaveLength(0);
  });
});

describe('createDeal — validation before any write', () => {
  it('names the unknown deal fields and creates nothing', async () => {
    const { db, queries } = makeDb(
      makeWorld({ customFields: [{ id: 'f2', field_name: 'Talle' }] })
    );

    await expect(
      createDeal(db, 'acct-1', {
        ...INPUT,
        fields: { talle: 'M', color: 'rojo', peso: '2' },
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/color, peso/),
    });
    expect(inserts(queries, 'deals')).toHaveLength(0);
    expect(findOrCreateContact).not.toHaveBeenCalled();
  });

  it('rejects a contact_id that belongs to another account', async () => {
    const { db, queries } = makeDb(makeWorld({ contact: null }));

    await expect(createDeal(db, 'acct-1', INPUT)).rejects.toMatchObject({
      status: 400,
      message: /contact_id/,
    });
    expect(inserts(queries, 'deals')).toHaveLength(0);
    const lookup = queries.find((q) => q.table === 'contacts');
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([['account_id', 'acct-1']])
    );
  });

  it('turns an invalid phone into a 400', async () => {
    vi.mocked(findOrCreateContact).mockRejectedValue(
      new ContactError("'phone' must be an international phone number", 400)
    );
    const { db, queries } = makeDb(makeWorld());

    await expect(
      createDeal(db, 'acct-1', {
        ...INPUT,
        contact: { kind: 'phone', phone: '099123456' },
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(inserts(queries, 'deals')).toHaveLength(0);
  });
});

describe('createDeal — idempotency (external_id)', () => {
  it('returns the existing deal on a replay without creating anything', async () => {
    const { db, queries } = makeDb(makeWorld({ externalLookups: [DEAL_ROW] }));

    const { deal, created } = await createDeal(db, 'acct-1', INPUT);

    expect(created).toBe(false);
    expect(deal.id).toBe('d1');
    expect(inserts(queries, 'deals')).toHaveLength(0);
    // A replay must not even create a stray contact.
    expect(findOrCreateContact).not.toHaveBeenCalled();
    const lookup = queries.find((q) => q.table === 'deals');
    expect(lookup?.filters).toEqual([
      ['account_id', 'acct-1'],
      ['external_id', 'ord-1'],
    ]);
  });

  it('returns the winner when a concurrent request takes the id first', async () => {
    const { db } = makeDb(
      makeWorld({
        // First lookup: nothing yet. Second (after the unique violation): the winner.
        externalLookups: [null, DEAL_ROW],
        insertResult: { data: null, error: { code: '23505' } },
      })
    );

    const { deal, created } = await createDeal(db, 'acct-1', INPUT);

    expect(created).toBe(false);
    expect(deal.id).toBe('d1');
  });

  it('skips the lookup entirely when there is no external_id', async () => {
    const { db, queries } = makeDb(makeWorld());

    await createDeal(db, 'acct-1', { ...INPUT, externalId: null });

    expect(
      queries.some(
        (q) =>
          q.table === 'deals' && q.filters.some(([c]) => c === 'external_id')
      )
    ).toBe(false);
  });
});

describe('createDeal — failures', () => {
  it('rolls the deal back when its field values cannot be saved', async () => {
    const { db, queries } = makeDb(
      makeWorld({
        customFields: [{ id: 'f2', field_name: 'Talle' }],
        valuesError: { message: 'boom' },
      })
    );

    await expect(
      createDeal(db, 'acct-1', { ...INPUT, fields: { talle: 'M' } })
    ).rejects.toMatchObject({ code: 'internal', status: 500 });

    const rollback = queries.find(
      (q) => q.table === 'deals' && q.op === 'delete'
    );
    expect(rollback?.filters).toEqual([
      ['id', 'd1'],
      ['account_id', 'acct-1'],
    ]);
  });

  it('answers 500 when the insert fails for another reason', async () => {
    const { db } = makeDb(
      makeWorld({ insertResult: { data: null, error: { code: '50000' } } })
    );

    await expect(createDeal(db, 'acct-1', INPUT)).rejects.toMatchObject({
      code: 'internal',
      status: 500,
    });
  });
});
