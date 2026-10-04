import type { SupabaseClient } from '@supabase/supabase-js'

import type { DispatchInput } from '@/lib/automations/engine'

export class DealStageError extends Error {
  readonly status: number

  constructor(message: string, status = 500) {
    super(message)
    this.name = 'DealStageError'
    this.status = status
  }
}

export interface MoveDealStageInput {
  /** RLS-scoped client of the calling user (not the service role). */
  db: SupabaseClient
  accountId: string
  dealId: string
  toStageId: string
}

export interface MoveDealStageResult {
  changed: boolean
  from_stage_id: string
  to_stage_id: string
  /**
   * The `deal_stage_changed` event to hand to `runAutomationsForTrigger`,
   * or null when the deal did not actually move. Returned instead of
   * dispatched here so the route can run it after the response is sent
   * (sending WhatsApp must not slow down the kanban drag).
   */
  event: DispatchInput | null
}

/**
 * Move a deal to another stage of its own pipeline.
 *
 * The update is compare-and-set on the previous stage: if two requests
 * race to move the same deal, only the one that actually changes the row
 * produces an event, so customers are never notified twice for one move.
 * Moving a deal to the stage it is already in is a no-op (no event).
 */
export async function moveDealStage(
  input: MoveDealStageInput
): Promise<MoveDealStageResult> {
  const { db, accountId, dealId, toStageId } = input

  const { data: deal, error: dealError } = await db
    .from('deals')
    .select('id, pipeline_id, stage_id, contact_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (dealError) throw new DealStageError('Could not load deal')
  if (!deal) throw new DealStageError('Deal not found', 404)

  const fromStageId = deal.stage_id as string
  if (fromStageId === toStageId) {
    return {
      changed: false,
      from_stage_id: fromStageId,
      to_stage_id: toStageId,
      event: null,
    }
  }

  // The destination must be a stage of the deal's own pipeline — a stage id
  // from another pipeline (or another account, which RLS hides) is refused.
  const { data: stage, error: stageError } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('id', toStageId)
    .eq('pipeline_id', deal.pipeline_id)
    .maybeSingle()

  if (stageError) throw new DealStageError('Could not verify stage')
  if (!stage) {
    throw new DealStageError('Stage does not belong to the deal pipeline', 400)
  }

  const { data: updated, error: updateError } = await db
    .from('deals')
    .update({ stage_id: toStageId })
    .eq('id', dealId)
    .eq('account_id', accountId)
    .eq('stage_id', fromStageId)
    .select('id')

  if (updateError) throw new DealStageError('Could not move deal')

  // Zero rows: a concurrent request moved the deal first. Nothing changed
  // here, so nothing to dispatch.
  if (!updated || updated.length === 0) {
    return {
      changed: false,
      from_stage_id: fromStageId,
      to_stage_id: toStageId,
      event: null,
    }
  }

  return {
    changed: true,
    from_stage_id: fromStageId,
    to_stage_id: toStageId,
    event: {
      accountId,
      triggerType: 'deal_stage_changed',
      contactId: (deal.contact_id as string | null) ?? null,
      context: {
        deal_id: dealId,
        pipeline_id: deal.pipeline_id as string,
        from_stage_id: fromStageId,
        to_stage_id: toStageId,
      },
    },
  }
}