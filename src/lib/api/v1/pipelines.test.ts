import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { listPipelines, PipelineError, serializePipeline } from './pipelines';

describe('serializePipeline', () => {
  it('orders stages by position, breaking ties by id', () => {
    const result = serializePipeline({
      id: 'p1',
      name: 'Pedidos',
      created_at: '2026-01-01T00:00:00Z',
      pipeline_stages: [
        { id: 'b', name: 'Listo', position: 2, color: '#0f0' },
        { id: 'z', name: 'Nuevo', position: 0, color: '#00f' },
        { id: 'a', name: 'Nuevo bis', position: 0, color: '#00f' },
      ],
    });

    expect(result.stages.map((s) => s.id)).toEqual(['a', 'z', 'b']);
  });

  it('returns the documented shape and nothing else', () => {
    const result = serializePipeline({
      id: 'p1',
      name: 'Pedidos',
      created_at: '2026-01-01T00:00:00Z',
      // Columns that must not leak onto the public wire.
      user_id: 'u1',
      account_id: 'acct-1',
      pipeline_stages: [
        { id: 's1', name: 'Nuevo', position: 0, color: '#00f' },
      ],
    });

    expect(result).toEqual({
      id: 'p1',
      name: 'Pedidos',
      created_at: '2026-01-01T00:00:00Z',
      stages: [{ id: 's1', name: 'Nuevo', position: 0, color: '#00f' }],
    });
  });

  it('tolerates a pipeline with no stages', () => {
    expect(
      serializePipeline({
        id: 'p1',
        name: 'Vacío',
        created_at: '',
        pipeline_stages: null,
      }).stages
    ).toEqual([]);
  });
});

/** Chainable stand-in recording the filters of the one query made. */
function makeDb(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {
    select: (...a: unknown[]) => (calls.push(['select', ...a]), builder),
    eq: (...a: unknown[]) => (calls.push(['eq', ...a]), builder),
    order: (...a: unknown[]) => (calls.push(['order', ...a]), builder),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
  };
  const db = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
  return { db, calls };
}

describe('listPipelines', () => {
  it('scopes the query to the account', async () => {
    const { db, calls } = makeDb({ data: [], error: null });

    await listPipelines(db, 'acct-1');

    expect(calls).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('serializes every row', async () => {
    const { db } = makeDb({
      data: [
        { id: 'p1', name: 'Pedidos', created_at: '', pipeline_stages: [] },
        { id: 'p2', name: 'Turnos', created_at: '', pipeline_stages: [] },
      ],
      error: null,
    });

    const result = await listPipelines(db, 'acct-1');

    expect(result.map((p) => p.name)).toEqual(['Pedidos', 'Turnos']);
  });

  it('throws a PipelineError when the database fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({ data: null, error: { message: 'boom' } });

    await expect(listPipelines(db, 'acct-1')).rejects.toBeInstanceOf(
      PipelineError
    );
  });
});
