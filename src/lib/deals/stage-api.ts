export interface MoveDealToStageResult {
  changed: boolean
  from_stage_id: string
  to_stage_id: string
}

/**
 * Move a deal to another stage through the server route, which changes the
 * stage and fires `deal_stage_changed` automations. Throws if the request
 * fails, so callers can revert their optimistic UI.
 */
export async function moveDealToStage(
  dealId: string,
  stageId: string
): Promise<MoveDealToStageResult> {
  const response = await fetch(`/api/deals/${dealId}/stage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage_id: stageId }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  } & Partial<MoveDealToStageResult>
  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to move deal')
  }
  return body as MoveDealToStageResult
}
