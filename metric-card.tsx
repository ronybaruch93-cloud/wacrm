import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  /** Kept for API compatibility; FLUXO drops the decorative icon tile. */
  icon?: ComponentType<{ className?: string }>
  /** Delta-mode secondary row. Omit when there is no sensible comparison. */
  delta?: {
    /** Positive / negative / zero drives the tone. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  /** Hero metric: bigger figure, brand colour. */
  featured?: boolean
}

/**
 * One cell of the metrics strip. It has no border of its own: the
 * dashboard wraps all cells in a single bordered container with dividers,
 * so the page reads as one strip with a hierarchy instead of four equal
 * cards.
 */
export function MetricCard({ title, value, delta, subtitle, featured }: MetricCardProps) {
  const tone =
    !delta || delta.sign === 0
      ? 'text-muted-foreground'
      : delta.sign > 0
        ? 'text-primary'
        : 'text-destructive'
  return (
    <div className="px-6 py-5">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p
        className={cn(
          'mt-2 font-heading leading-none font-semibold tracking-tight tabular-nums',
          featured ? 'text-5xl text-primary' : 'text-3xl text-foreground',
        )}
      >
        {value}
      </p>
      {delta ? (
        <p className={cn('mt-2 text-xs tabular-nums', tone)}>{delta.label}</p>
      ) : subtitle ? (
        <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}
