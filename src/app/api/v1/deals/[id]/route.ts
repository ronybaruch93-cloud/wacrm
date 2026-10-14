// ============================================================
// GET   /api/v1/deals/{id} — read a deal    (scope: deals:read)
// PATCH /api/v1/deals/{id} — update a deal  (scope: deals:write)
//
// Both are account-scoped: a deal belonging to another account (or an
// id that is not even well-formed) answers 404, never 403 — don't
// reveal that it exists elsewhere.
//
// Changing `stage_id` here is what lets an integrator drive
// `deal_stage_changed` automations (e.g. "your order is ready").
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import {
  getDealById,
  parseDealId,
  parseUpdateDeal,
  updateDeal,
} from '@/lib/api/v1/deals';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const dealId = parseDealId((await params).id);

    const deal = await getDealById(ctx.supabase, ctx.accountId, dealId);
    if (!deal) return fail('not_found', 'Deal not found', 404);
    return ok(deal);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const dealId = parseDealId((await params).id);

    const body = await request.json().catch(() => null);
    const input = parseUpdateDeal(body);

    const { deal, event } = await updateDeal(
      ctx.supabase,
      ctx.accountId,
      dealId,
      input
    );

    // Dispatch after the response, so a slow WhatsApp send never delays
    // the integrator's call. runAutomationsForTrigger catches its own errors.
    if (event) {
      after(() => runAutomationsForTrigger(event));
    }

    return ok(deal);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
