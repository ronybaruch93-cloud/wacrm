import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  getDealById: vi.fn(),
  updateDeal: vi.fn(),
  dispatch: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      h.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: h.requireApiKey,
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.dispatch,
}));

// Keep the real parsers (they are what turns bad input into a 400/404);
// only the two functions that touch the database are replaced.
vi.mock('@/lib/api/v1/deals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/deals')>();
  return {
    ...actual,
    getDealById: h.getDealById,
    updateDeal: h.updateDeal,
  };
});

import { ApiError } from '@/lib/api/v1/respond';
import { GET, PATCH } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { supabase: { name: 'service-client' }, accountId: 'acct-1' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const DEAL = { id: ID, title: 'Pedido', status: 'open' };
const EVENT = {
  accountId: 'acct-1',
  triggerType: 'deal_stage_changed' as const,
  contactId: 'c1',
  context: { deal_id: ID, to_stage_id: 's2' },
};

function patch(body: unknown) {
  return new Request(`http://localhost/api/v1/deals/${ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const get = () => new Request(`http://localhost/api/v1/deals/${ID}`);

beforeEach(() => {
  h.requireApiKey.mockReset();
  h.getDealById.mockReset();
  h.updateDeal.mockReset();
  h.dispatch.mockReset();
  h.afterCallbacks.length = 0;
  h.requireApiKey.mockResolvedValue(ctx);
  h.dispatch.mockResolvedValue(undefined);
});

describe('GET /api/v1/deals/{id}', () => {
  it('requires deals:read and returns the deal', async () => {
    h.getDealById.mockResolvedValue(DEAL);

    const res = await GET(get(), params(ID));

    expect(res.status).toBe(200);
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'deals:read'
    );
    expect(h.getDealById).toHaveBeenCalledWith(ctx.supabase, 'acct-1', ID);
    expect(await res.json()).toEqual({ data: DEAL });
  });

  it('answers 404 for a deal that is not in the account', async () => {
    h.getDealById.mockResolvedValue(null);

    const res = await GET(get(), params(ID));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('answers 404 for a malformed id without querying the database', async () => {
    const res = await GET(get(), params('not-a-uuid'));

    expect(res.status).toBe(404);
    expect(h.getDealById).not.toHaveBeenCalled();
  });

  it('passes a missing-scope rejection through as 403', async () => {
    h.requireApiKey.mockRejectedValue(
      new ApiError(
        'forbidden',
        'API key is missing the "deals:read" scope',
        403
      )
    );

    const res = await GET(get(), params(ID));

    expect(res.status).toBe(403);
    expect(h.getDealById).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/deals/{id}', () => {
  it('requires deals:write and passes the parsed input to updateDeal', async () => {
    h.updateDeal.mockResolvedValue({ deal: DEAL, event: null });

    const res = await PATCH(
      patch({ title: ' Nuevo ', status: 'won' }),
      params(ID)
    );

    expect(res.status).toBe(200);
    expect(h.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'deals:write'
    );
    expect(h.updateDeal).toHaveBeenCalledWith(ctx.supabase, 'acct-1', ID, {
      title: 'Nuevo',
      status: 'won',
    });
    expect(await res.json()).toEqual({ data: DEAL });
  });

  it('dispatches the stage-change event after the response, not during it', async () => {
    h.updateDeal.mockResolvedValue({ deal: DEAL, event: EVENT });

    await PATCH(patch({ stage_id: ID }), params(ID));

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.afterCallbacks).toHaveLength(1);

    await h.afterCallbacks[0]();
    expect(h.dispatch).toHaveBeenCalledWith(EVENT);
  });

  it('does not dispatch when the stage did not change', async () => {
    h.updateDeal.mockResolvedValue({ deal: DEAL, event: null });

    await PATCH(patch({ title: 'x' }), params(ID));

    expect(h.afterCallbacks).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty body', {}],
    ['an unknown field', { titulo: 'x' }],
    ['an immutable field', { external_id: 'x' }],
    ['invalid JSON', 'not json'],
  ])('answers 400 for %s without touching the deal', async (_n, body) => {
    const res = await PATCH(patch(body), params(ID));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(h.updateDeal).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id without touching the deal', async () => {
    const res = await PATCH(patch({ title: 'x' }), params('nope'));

    expect(res.status).toBe(404);
    expect(h.updateDeal).not.toHaveBeenCalled();
  });

  it('maps an error from updateDeal to its status and never dispatches', async () => {
    h.updateDeal.mockRejectedValue(
      new ApiError('not_found', 'Deal not found', 404)
    );

    const res = await PATCH(patch({ title: 'x' }), params(ID));

    expect(res.status).toBe(404);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('passes a missing-scope rejection through as 403', async () => {
    h.requireApiKey.mockRejectedValue(
      new ApiError(
        'forbidden',
        'API key is missing the "deals:write" scope',
        403
      )
    );

    const res = await PATCH(patch({ title: 'x' }), params(ID));

    expect(res.status).toBe(403);
    expect(h.updateDeal).not.toHaveBeenCalled();
  });
});
