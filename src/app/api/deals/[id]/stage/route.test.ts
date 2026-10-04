import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  move: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (cb: () => unknown) => {
      h.afterCallbacks.push(cb)
    },
  }
})

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.dispatch,
}))

vi.mock('@/lib/deals/stage-events', () => ({
  DealStageError: class DealStageError extends Error {
    status: number
    constructor(message: string, status = 500) {
      super(message)
      this.status = status
    }
  },
  moveDealStage: h.move,
}))

import { DealStageError } from '@/lib/deals/stage-events'
import { PATCH } from './route'

const context = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
}

const params = { params: Promise.resolve({ id: 'deal-1' }) }

function request(body: unknown) {
  return new Request('http://localhost/api/deals/deal-1/stage', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const EVENT = {
  accountId: 'account-1',
  triggerType: 'deal_stage_changed' as const,
  contactId: 'contact-1',
  context: {
    deal_id: 'deal-1',
    pipeline_id: 'pipe-1',
    from_stage_id: 'stage-old',
    to_stage_id: 'stage-new',
  },
}

beforeEach(() => {
  h.requireRole.mockReset()
  h.move.mockReset()
  h.dispatch.mockReset()
  h.afterCallbacks.length = 0
  h.requireRole.mockResolvedValue(context)
  h.dispatch.mockResolvedValue(undefined)
})

describe('PATCH /api/deals/[id]/stage', () => {
  it('requires an agent and moves the deal with the scoped client', async () => {
    h.move.mockResolvedValue({
      changed: true,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-new',
      event: EVENT,
    })

    const response = await PATCH(request({ stage_id: 'stage-new' }), params)

    expect(response.status).toBe(200)
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(h.move).toHaveBeenCalledWith({
      db: context.supabase,
      accountId: 'account-1',
      dealId: 'deal-1',
      toStageId: 'stage-new',
    })
    expect(await response.json()).toEqual({
      ok: true,
      changed: true,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-new',
    })
  })

  it('dispatches the event after the response, not during the request', async () => {
    h.move.mockResolvedValue({
      changed: true,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-new',
      event: EVENT,
    })

    await PATCH(request({ stage_id: 'stage-new' }), params)

    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.afterCallbacks).toHaveLength(1)

    await h.afterCallbacks[0]()
    expect(h.dispatch).toHaveBeenCalledWith(EVENT)
  })

  it('does not dispatch when the deal did not actually move', async () => {
    h.move.mockResolvedValue({
      changed: false,
      from_stage_id: 'stage-old',
      to_stage_id: 'stage-old',
      event: null,
    })

    const response = await PATCH(request({ stage_id: 'stage-old' }), params)

    expect(response.status).toBe(200)
    expect(h.afterCallbacks).toHaveLength(0)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a missing or blank stage_id and invalid JSON', async () => {
    for (const body of [{}, { stage_id: '   ' }, { stage_id: 42 }, 'not json']) {
      const response = await PATCH(request(body), params)
      expect(response.status).toBe(400)
    }
    expect(h.move).not.toHaveBeenCalled()
  })

  it('maps DealStageError to its status', async () => {
    h.move.mockRejectedValue(new DealStageError('Deal not found', 404))

    const response = await PATCH(request({ stage_id: 'stage-new' }), params)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Deal not found' })
  })

  it('returns the auth error response when the role check fails', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))

    const response = await PATCH(request({ stage_id: 'stage-new' }), params)

    expect(response.status).toBe(403)
    expect(h.move).not.toHaveBeenCalled()
  })
})