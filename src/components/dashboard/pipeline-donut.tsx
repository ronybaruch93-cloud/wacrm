"use client"

import { GitBranch } from 'lucide-react'
import type { PipelineDonutData } from '@/lib/dashboard/types'
import { formatCurrency } from '@/lib/currency'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface PipelineDonutProps {
  data: PipelineDonutData | null
  loading: boolean
  /** Account default currency for the totals. */
  currency: string
}

import { useTranslations } from 'next-intl'

export function PipelineDonut({ data, loading, currency }: PipelineDonutProps) {
  const t = useTranslations('Dashboard.pipelineDonut')
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('description')}
        </p>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {loading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : data.stages.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title={t('noOpenDeals')}
            hint={t('noOpenDealsHint')}
          />
        ) : (
          <>
            <p className="font-heading text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatCurrency(data.totalValue, currency)}
            </p>
            <p className="text-xs text-muted-foreground">{t('total')}</p>
            {/* Stage line: a vertical rail with one dot per stage. */}
            <ul className="mt-5 ml-1.5 border-l-2 border-border">
              {data.stages.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
                  <span
                    className="-ml-[7px] h-3 w-3 flex-shrink-0 rounded-full ring-4 ring-card"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate font-medium text-foreground">{s.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('dealCount', { count: s.dealCount })}
                  </span>
                  <span className="w-24 text-right font-mono text-xs text-foreground tabular-nums">
                    {formatCurrency(s.totalValue, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
