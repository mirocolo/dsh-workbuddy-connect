import { describe, expect, it } from 'vitest'
import {
  DOCK_VARIANTS,
  buildCreditLine,
  buildDockLine,
  cardVariantFor,
  currentModelSelection,
  currentWorkBuddyRate,
  formatCompactCredits,
  formatCreditTotal,
  renderDockSegments,
} from '../src/client/credit-line.ts'
import type { WorkBuddyDockLoad, WorkBuddyModelSelectionProjection } from '../src/client/credit-line.ts'
import type { WorkBuddyWebCredits, WorkBuddyWebModelBadge, WorkBuddyWebStatus } from '../src/status-paths.ts'
import { en } from '../src/client/locales.ts'
import { CARD_VARIANTS } from '../src/client/WorkBuddyPluginCard.tsx'

/**
 * Credit-line tests. The line is pure display logic, so these pin the decisions
 * that would otherwise silently change what a user reads under the composer:
 * which selection counts, when a rate may be stated at all, and the rule that
 * every phase still renders copy instead of collapsing the row.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** A signed-in status document carrying the given models and credits. */
function signedIn(overrides: {
  credits?: WorkBuddyWebCredits
  models?: readonly WorkBuddyWebModelBadge[]
  creditsError?: string
} = {}): WorkBuddyDockLoad {
  return {
    phase: 'ok',
    value: { status: 'signed-in', ...overrides } as WorkBuddyWebStatus,
  }
}

/** A projection whose `next` (or `lastUsed`) carries the given selection. */
function projection(
  selection: { provider: string; model: string } | null,
  where: 'next' | 'lastUsed' = 'next',
): WorkBuddyModelSelectionProjection {
  return { next: where === 'next' ? selection : null, lastUsed: where === 'lastUsed' ? selection : null }
}

describe('credit-line formatting', () => {
  it('compacts credit the way the composer formats tokens', () => {
    expect(formatCompactCredits(0)).toBe('0')
    expect(formatCompactCredits(352)).toBe('352')
    expect(formatCompactCredits(1_200)).toBe('1.2K')
    expect(formatCompactCredits(1_000_000)).toBe('1M')
  })

  it('keeps one decimal below 100 and rounds integers above it', () => {
    expect(formatCompactCredits(99.44)).toBe('99.4')
    expect(formatCompactCredits(100.4)).toBe('100')
  })

  it('groups the exact total', () => {
    expect(formatCreditTotal(1642)).toBe(new Intl.NumberFormat(undefined).format(1642))
  })
})

describe('cardVariantFor', () => {
  it('routes each provider id to its own product', () => {
    expect(cardVariantFor('workbuddy')?.id).toBe('workbuddy')
    expect(cardVariantFor('workbuddy-ai')?.id).toBe('workbuddy-ai')
  })

  it('returns nothing for a foreign provider', () => {
    expect(cardVariantFor('llm-pi-ai')).toBeUndefined()
  })

  it('agrees with the settings card on ids and status routes', () => {
    // The dock keeps its own variant list so it stays component-free; this is
    // what stops the two tables from drifting apart on the facts they share.
    expect(DOCK_VARIANTS.map(variant => ({ id: variant.id, statusPath: variant.statusPath })))
      .toEqual(CARD_VARIANTS.map(card => ({ id: card.id, statusPath: card.statusPath })))
  })
})

describe('currentModelSelection', () => {
  it('prefers the selection the next request will use', () => {
    const both: WorkBuddyModelSelectionProjection = {
      next: { provider: 'workbuddy', model: 'glm-5.3' },
      lastUsed: { provider: 'workbuddy', model: 'glm-5.2' },
    }
    expect(currentModelSelection(both)?.model).toBe('glm-5.3')
  })

  it('falls back to the last used selection, and to null when absent', () => {
    expect(currentModelSelection(projection({ provider: 'workbuddy', model: 'hy3' }, 'lastUsed'))?.model).toBe('hy3')
    expect(currentModelSelection(undefined)).toBeNull()
    expect(currentModelSelection({ next: null, lastUsed: null })).toBeNull()
  })
})

describe('buildCreditLine', () => {
  it('drops exhausted packages and orders the rest largest first', () => {
    const line = buildCreditLine({
      total: 300,
      accounts: [
        { packageName: 'small', remain: 100, size: 1_000 },
        { packageName: 'spent', remain: 0, size: 1_000 },
        { packageName: 'big', remain: 200, size: 1_000 },
      ],
    })
    expect(line?.rows.map(row => row.packageName)).toEqual(['big', 'small'])
    expect(line?.empty).toBe(false)
  })

  it('reports empty rather than hiding a zero balance', () => {
    const line = buildCreditLine({ total: 0, accounts: [] })
    expect(line?.empty).toBe(true)
    expect(line?.total).toBe(0)
  })

  it('carries an uncapped quota through instead of collapsing it into total', () => {
    // An unlimited enterprise quota and an exhausted one are opposite facts;
    // both would otherwise print as a number and read the same.
    const line = buildCreditLine({ total: 0, accounts: [], unlimited: true })
    expect(line?.unlimited).toBe(true)
    expect(line?.empty).toBe(false)
  })

  it('is null when the document carries no credit section at all', () => {
    expect(buildCreditLine(undefined)).toBeNull()
  })
})

describe('currentWorkBuddyRate', () => {
  const models: readonly WorkBuddyWebModelBadge[] = [
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
    { id: 'expired', name: 'Expired', rateUnknown: true },
    { id: 'plain', name: 'Plain' },
  ]

  it('states the multiplier and display name when the catalog knows them', () => {
    const rate = currentWorkBuddyRate({ provider: 'workbuddy', model: 'glm-5.3' }, models)
    expect(rate).toEqual({ rate: 'x0.79', name: 'GLM-5.3', unknown: false })
  })

  it('marks a stale promotional price unknown instead of repeating it', () => {
    // The upstream bakes the discounted value into its own field, so neither the
    // old figure nor "free" may be shown once the promotion ends.
    const rate = currentWorkBuddyRate({ provider: 'workbuddy', model: 'expired' }, models)
    expect(rate?.unknown).toBe(true)
  })

  it('stays null for a row with no billing facts, and for an unknown model', () => {
    expect(currentWorkBuddyRate({ provider: 'workbuddy', model: 'plain' }, models)).toBeNull()
    expect(currentWorkBuddyRate({ provider: 'workbuddy', model: 'nope' }, models)).toBeNull()
  })
})

describe('buildDockLine', () => {
  it('shows just the credit figure for a WorkBuddy selection', () => {
    // The provider and model are already named by the composer's model picker
    // directly above this row, so repeating them here would be duplication.
    const line = buildDockLine(
      projection({ provider: 'workbuddy', model: 'glm-5.3' }),
      signedIn({
        credits: { total: 1_642, accounts: [{ packageName: 'p', remain: 1_642, size: 2_000 }] },
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' }],
      }),
    )
    expect(renderDockSegments(line.segments, t)).toBe('Credit 1,642')
  })

  it('renders nothing at all for another provider', () => {
    const line = buildDockLine(projection({ provider: 'llm-pi-ai', model: 'gpt-4o' }), {
      phase: 'idle',
    })
    expect(line.workbuddy).toBe(false)
    expect(line.credits).toBeNull()
    expect(line.rate).toBeNull()
    // An empty line is the component's signal to render no row, so the composer
    // keeps its normal spacing under a foreign provider.
    expect(line.segments).toEqual([])
  })

  it('renders nothing at all when no model has been chosen', () => {
    expect(buildDockLine(undefined, { phase: 'idle' }).segments).toEqual([])
  })

  it('still states the rate of the selected model in the panel value', () => {
    // The multiplier left the line but stays available to the details panel,
    // which has no picker above it to read the price from.
    const line = buildDockLine(
      projection({ provider: 'workbuddy', model: 'glm-5.3' }),
      signedIn({ models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' }] }),
    )
    expect(line.rate).toEqual({ rate: 'x0.79', name: 'GLM-5.3', unknown: false })
  })

  it('gives every unusable state its own wording rather than collapsing', () => {
    const selection = projection({ provider: 'workbuddy', model: 'glm-5.3' })
    expect(renderDockSegments(buildDockLine(selection, { phase: 'loading' }).segments, t))
      .toContain('Credit …')
    expect(renderDockSegments(buildDockLine(selection, { phase: 'ok', value: { status: 'signed-out' } }).segments, t))
      .toContain('Not signed in')
    expect(renderDockSegments(buildDockLine(selection, { phase: 'error', message: 'HTTP 500' }).segments, t))
      .toContain('Credit unavailable')
  })

  it('shows an unlimited quota without printing a total', () => {
    const line = buildDockLine(
      projection({ provider: 'workbuddy', model: 'glm-5.3' }),
      signedIn({ credits: { total: 0, accounts: [], unlimited: true } }),
    )
    expect(renderDockSegments(line.segments, t)).toContain('Credit unlimited')
  })

  it('reads the second product through its own variant', () => {
    const line = buildDockLine(projection({ provider: 'workbuddy-ai', model: 'glm-5.3' }), signedIn())
    expect(line.variant?.id).toBe('workbuddy-ai')
    expect(line.workbuddy).toBe(true)
  })
})
