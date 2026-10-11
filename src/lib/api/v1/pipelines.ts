// ============================================================
// Public API (v1) — pipelines.
//
// Read-only. An integrator creating a deal needs the id of the
// pipeline (and optionally a stage) to put it in, and those ids are
// not shown anywhere in the dashboard — this is how they find them.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ApiStage {
  id: string;
  name: string;
  position: number;
  color: string;
}

export interface ApiPipeline {
  id: string;
  name: string;
  /** In board order, first stage first. */
  stages: ApiStage[];
  created_at: string;
}

export const PIPELINE_SELECT =
  'id, name, created_at, pipeline_stages(id, name, position, color)';

export class PipelineError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'PipelineError';
    this.status = status;
  }
}

/** Flatten a `pipelines` row with its embedded `pipeline_stages`. */
export function serializePipeline(row: Record<string, unknown>): ApiPipeline {
  const rawStages = Array.isArray(row.pipeline_stages)
    ? row.pipeline_stages
    : [];
  const stages = (rawStages as Array<Record<string, unknown>>)
    .map((s) => ({
      id: s.id as string,
      name: s.name as string,
      position: Number(s.position ?? 0),
      color: (s.color as string) ?? '',
    }))
    // Same order the board draws them in; id breaks ties so the order is
    // stable between calls.
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  return {
    id: row.id as string,
    name: row.name as string,
    stages,
    created_at: row.created_at as string,
  };
}

/**
 * Every pipeline of `accountId`, oldest first. The service-role client
 * bypasses RLS, so the account filter is the only thing keeping one
 * tenant out of another's pipelines.
 */
export async function listPipelines(
  db: SupabaseClient,
  accountId: string
): Promise<ApiPipeline[]> {
  const { data, error } = await db
    .from('pipelines')
    .select(PIPELINE_SELECT)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    console.error('[api/v1/pipelines] list error:', error);
    throw new PipelineError('Failed to list pipelines');
  }
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
    serializePipeline
  );
}
