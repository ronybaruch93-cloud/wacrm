import { afterEach, describe, expect, it, vi } from 'vitest'

import { moveDealToStage } from './stage-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('moveDealToStage', () => {
  it('PATCHes the stage route and returns the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        changed: true,
        from_stage_id: 'a',
        to_stage_id: 'b',
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await moveDealToStage('deal-1', 'b')

    expect(fetchMock).toHaveBeenCalledWith('/api/deals/deal-1/stage', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: 'b' }),
    })
    expect(result).toMatchObject({ changed: true, to_stage_id: 'b' })
  })

  it('throws the server error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ error: 'Deal not found' }, { status: 404 })
      )
    )

    await expect(moveDealToStage('deal-1', 'b')).rejects.toThrow('Deal not found')
  })

  it('throws a generic error when the failure body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('oops', { status: 500 }))
    )

    await expect(moveDealToStage('deal-1', 'b')).rejects.toThrow(
      'Failed to move deal'
    )
  })
})
