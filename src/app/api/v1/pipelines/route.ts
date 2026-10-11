// ============================================================
// GET /api/v1/pipelines — list pipelines with their stages
//                         (scope: deals:read)
//
// Not paginated: an account has a handful of pipelines. The list
// envelope is still used (with a null cursor) so integrators can parse
// every v1 list the same way.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { listPipelines, PipelineError } from '@/lib/api/v1/pipelines';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const pipelines = await listPipelines(ctx.supabase, ctx.accountId);
    return okList(pipelines, null);
  } catch (err) {
    if (err instanceof PipelineError) {
      return fail('internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
