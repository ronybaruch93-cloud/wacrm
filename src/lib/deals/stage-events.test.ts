import { describe, expect, it } from 'vitest'

import { DealStageError, moveDealStage } from './stage-events'

interface FakeState {
  deal: Record<string, unknown> | null
  dealError?: boolean
  stage: Record<string, unknown> | null
  updated: Array<{ id: string }> | null
  updateError?: boolean
}

interface RecordedQuery {
  table: string
  op: 'select' | 'update'
  filters: Array<[string, unknown]>
  patch?: Record<string, unknown>
}

/** Minimal chainable stand-in for the three queries moveDealStage makes. */
function makeDb(state: FakeState) {
  const queries: RecordedQuery[] = []

  function resolve(q: RecordedQuery) {
    if (q.table === 'deals' && q.op === 'select') {
      return state.dealError
        ? { data: null, error: { message: 'boom' } }
        : { data: state.deal, error: null }
    }
    if (q.table === 'pipeline_stages') {
      return { data: state.stage, error: null }
    }
    return state.updateError
      ? { data: null, error: { message: 'boom' } }
      : { data: state.updated, error: null }
  }

  const db = {
    queries,
    from(table: string) {
      const q: RecordedQuery = { table, op: 'select', filters: [] }
      const builder = {
        select() {
          return builder
        },
        update(patch: Record<string, unknown>) {
          q.op = 'update'
          q.patch = patch
          return builder
        },
        eq(column: string, value: unknown) {
          q.filters.push([column, value])
          return builder
        },
        maybeSingle() {
          queries.push(q)
          return Promise.resolve(resolve(q))
        },
        then(
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (e: unknown) => unknown
        ) {
          queries.push(q)
          return Promise.resolve(resolve(q)).then(onFulfilled, onRejected)
        },
      }
      return builder
    },
  }
  return db
}

const DEAL = {
  id: 'deal-1',
  pipeline_id: 'pipe-1',
  stage_id: 'stage-old',
  contact_id: 'contact-1',
}

function input(db: ReturnType<typeof makeDb>, toStageId = 'stage-new') {
  return {
    db: db as never,
    accountId: 'account-1',
    dealId: 'deal-1',
    toStageId,
  }
}

describe('moveDealStage', () => {
  it('moves the deal and returns the event to dispatch', async () => {
    const db = makeDb({
      deal: DEAL,
      stage: { id: 'stage-new' },
      updated: [{ id: 'deal-1' }],
    })

    const result = await moveDealStage(input(db))

    expect(result).toEqual({
      changed: true,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-new',
      event: {
        accountId: 'account-1',
        triggerType: 'deal_stage_changed',
        contactId: 'contact-1',
        context: {
          deal_id: 'deal-1',
          pipeline_id: 'pipe-1',
          from_stage_id: 'stage-old',
          to_stage_id: 'stage-new',
        },
      },
    })
  })

  it('updates only if the deal is still in the stage it was read in', async () => {
    const db = makeDb({
      deal: DEAL,
      stage: { id: 'stage-new' },
      updated: [{ id: 'deal-1' }],
    })

    await moveDealStage(input(db))

    const update = db.queries.find((q) => q.op === 'update')
    expect(update?.patch).toEqual({ stage_id: 'stage-new' })
    expect(update?.filters).toEqual([
      ['id', 'deal-1'],
      ['account_id', 'account-1'],
      ['stage_id', 'stage-old'],
    ])
  })

  it('checks the destination stage against the deal pipeline', async () => {
    const db = makeDb({
      deal: DEAL,
      stage: { id: 'stage-new' },
      updated: [{ id: 'deal-1' }],
    })

    await moveDealStage(input(db))

    const stageQuery = db.queries.find((q) => q.table === 'pipeline_stages')
    expect(stageQuery?.filters).toEqual([
      ['id', 'stage-new'],
      ['pipeline_id', 'pipe-1'],
    ])
  })

  it('is a no-op without an event when the deal is already in that stage', async () => {
    const db = makeDb({ deal: DEAL, stage: null, updated: null })

    const result = await moveDealStage(input(db, 'stage-old'))

    expect(result).toEqual({
      changed: false,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-old',
      event: null,
    })
    expect(db.queries.map((q) => q.table)).toEqual(['deals'])
  })

  it('refuses a stage that is not in the deal pipeline, without updating', async () => {
    const db = makeDb({ deal: DEAL, stage: null, updated: null })

    await expect(moveDealStage(input(db))).rejects.toMatchObject({
      name: 'DealStageError',
      status: 400,
    })
    expect(db.queries.some((q) => q.op === 'update')).toBe(false)
  })

  it('returns 404 when the deal is not visible to the caller', async () => {
    const db = makeDb({ deal: null, stage: null, updated: null })

    await expect(moveDealStage(input(db))).rejects.toMatchObject({
      status: 404,
    })
  })

  it('produces no event when a concurrent request moved the deal first', async () => {
    const db = makeDb({ deal: DEAL, stage: { id: 'stage-new' }, updated: [] })

    const result = await moveDealStage(input(db))

    expect(result.changed).toBe(false)
    expect(result.event).toBeNull()
  })

  it('passes a null contact through to the event', async () => {
    const db = makeDb({
      deal: { ...DEAL, contact_id: null },
      stage: { id: 'stage-new' },
      updated: [{ id: 'deal-1' }],
    })

    const result = await moveDealStage(input(db))

    expect(result.event?.contactId).toBeNull()
  })

  it('surfaces database errors as DealStageError', async () => {
    const db = makeDb({
      deal: DEAL,
      stage: { id: 'stage-new' },
      updated: null,
      updateError: true,
    })

    await expect(moveDealStage(input(db))).rejects.toBeInstanceOf(DealStageError)
  })
})