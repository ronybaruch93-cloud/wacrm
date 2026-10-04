import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { DealStageError, moveDealStage } from '@/lib/deals/stage-events'

/**
 * Move a deal to another stage and fire `deal_stage_changed` automations.
 *
 * The kanban and the deal form used to write `stage_id` straight from the
 * browser, which left no server-side hook to run automations from. Routing
 * the move through here gives one place that changes the stage and, only
 * when the stage really changed, dispatches the event. The write goes
 * through the caller's RLS-scoped client, so it needs the same `agent`
 * role the old direct update did.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent')
    const { id: dealId } = await params

    const body = (await request.json().catch(() => null)) as {
      stage_id?: unknown
    } | null
    const stageId =
      typeof body?.stage_id === 'string' && body.stage_id.trim()
        ? body.stage_id.trim()
        : null
    if (!stageId) {
      return NextResponse.json({ error: 'stage_id required' }, { status: 400 })
    }

    const result = await moveDealStage({
      db: ctx.supabase,
      accountId: ctx.accountId,
      dealId,
      toStageId: stageId,
    })

    // Dispatch after the response so a slow WhatsApp send never delays the
    // drag-and-drop. runAutomationsForTrigger catches its own errors.
    if (result.event) {
      const event = result.event
      after(() => runAutomationsForTrigger(event))
    }

    return NextResponse.json({
      ok: true,
      changed: result.changed,
      from_stage_id: result.from_stage_id,
      to_stage_id: result.to_stage_id,
    })
  } catch (error) {
    if (error instanceof DealStageError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}