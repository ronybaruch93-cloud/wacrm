// ============================================================
// POST /api/v1/deals — create a deal: an order, booking, etc.
//                      (scope: deals:write)
//
// Idempotent when the caller sends `external_id`: repeating the call
// returns the deal already created (200) instead of a second one (201).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { createDeal, parseCreateDeal } from '@/lib/api/v1/deals';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = await request.json().catch(() => null);
    const input = parseCreateDeal(body);

    const { deal, created } = await createDeal(
      ctx.supabase,
      ctx.accountId,
      input
    );
    return ok(deal, created ? 201 : 200);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
