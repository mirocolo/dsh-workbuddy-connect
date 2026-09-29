/**
 * Pure display helpers for the composer credit line, split out of the
 * component so the Node test environment can exercise them without loading the
 * browser-only DSH slot packages.
 *
 * The line is one row under the input box carrying the remaining credit, and
 * nothing else: the provider and model are already named by the composer's own
 * model picker directly above it, so repeating them here would say the same
 * thing twice in adjacent lines. The multiplier is likewise kept out of the line
 * and shown only in the details panel the row opens — the picker already prints
 * a rate beside each model name.
 *
 * What the line does share with `dsh-codebuddy-cli`'s own composer dock is the
 * rule that every unusable state still renders wording rather than an empty
 * row. Where the facts come from differs: that plugin owns a single provider and
 * a single status route, while this one serves two independently installed
 * products, each with its own status route, and publishes per-model billing
 * inside `models[]` rather than in a separate `catalog.rates` map.
 *
 * @module dsh-workbuddy-connect/client/credit-line
 */

import { WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyWebCredits, WorkBuddyWebModelBadge, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/**
 * The two products this dock serves, in display order.
 *
 * These mirror `CARD_VARIANTS` in the card module, and a spec asserts that they
 * agree — the card reaches its routes through `WorkBuddyCardVariant` while this
 * module stays component-free, so the ids and paths are the shared facts worth
 * pinning.
 */
export const DOCK_VARIANTS: readonly WorkBuddyDockVariant[] = [
  { id: 'workbuddy', appName: 'WorkBuddy', statusPath: WORKBUDDY_STATUS_PATH },
  { id: 'workbuddy-ai', appName: 'WorkBuddy AI', statusPath: WORKBUDDY_AI_STATUS_PATH },
]

/**
 * The browser-visible half of a product variant, as this module needs it.
 *
 * Declared structurally rather than imported from the card component: this is a
 * pure display module that the Node test environment and the host-side typecheck
 * both load, and importing a `.tsx` file would pull JSX into a tsconfig that has
 * no `jsx` setting. `WorkBuddyCardVariant` in the card module satisfies this
 * shape, so the two cannot drift on the fields read here.
 */
export interface WorkBuddyDockVariant {
  readonly id: string
  readonly appName: string
  readonly statusPath: string
}

/**
 * Resolve which product variant a provider id belongs to.
 *
 * The dock serves both products from one seat, so the provider id is what picks
 * the status route. Returning `undefined` for any other provider is what keeps
 * every non-WorkBuddy model on the plain provider/model row.
 */
export function cardVariantFor(provider: string): WorkBuddyDockVariant | undefined {
  return DOCK_VARIANTS.find(card => card.id === provider)
}

/** The narrow slice of the session's model selection the dock reads. */
export interface WorkBuddyDockSelection {
  readonly provider: string
  readonly model: string
}

/**
 * The client-facing `modelSelection` projection: `next` is the selection the
 * next request will use, falling back to `lastUsed`. Registered by
 * `@deepseek-ai/dsh-client-ui-model-selection` and read through the host's
 * `useProjection` seat.
 */
export interface WorkBuddyModelSelectionProjection {
  readonly lastUsed: WorkBuddyDockSelection | null
  readonly next: WorkBuddyDockSelection | null
}

/**
 * The selection the composer is about to use: `next` wins over `lastUsed`,
 * because that is the one the user just picked. An absent projection (no model
 * chosen yet in this session, or the projection has not landed) resolves to
 * null.
 *
 * Every provider read below goes through this one helper so they cannot drift
 * apart on which selection counts.
 */
export function currentModelSelection(
  projection: WorkBuddyModelSelectionProjection | undefined,
): WorkBuddyDockSelection | null {
  return projection?.next ?? projection?.lastUsed ?? null
}

/** The composer dock's credit line, or null when nothing displayable exists. */
export interface WorkBuddyCreditLine {
  /** Whole number, shown in the details panel. */
  readonly total: number
  /** Per-package rows for the details panel (remain>0 only), largest first. */
  readonly rows: readonly WorkBuddyWebCredits['accounts'][number][]
  /** True when the upstream answer reports no credit at all. */
  readonly empty: boolean
  /** The account's quota is uncapped; every renderer must test this before `total`. */
  readonly unlimited: boolean
}

/** Trim fractional noise: one decimal under 100, integers from there on. */
function scaleText(candidate: number): string {
  const scaled = candidate >= 100 ? Math.round(candidate) : Math.round(candidate * 10) / 10
  return String(scaled)
}

/**
 * Compact a credit count the way the composer formats tokens (`1.2K`).
 *
 * Mirrors ui-conversation's ContextMeter thresholds so the credit figure and the
 * host's own token meter read as one family, which is the whole reason the two
 * sit side by side.
 */
export function formatCompactCredits(value: number): string {
  // The sub-1000 branch rounds too: a fractional remainder is not a credit
  // figure a user can act on, and letting `99.44` through would make the row
  // disagree with the panel's own rounded total beside it.
  if (value < 1_000) return scaleText(value)
  if (value < 1_000_000) return `${scaleText(value / 1_000)}K`
  return `${scaleText(value / 1_000_000)}M`
}

/** Exact credit figure with thousands separators, e.g. `1,642`. */
export function formatCreditTotal(total: number): string {
  return new Intl.NumberFormat(undefined).format(total)
}

/**
 * Build the credit line from a status document's credit section.
 *
 * Packages with no remaining credit drop out (the settings card filters the same
 * way); a signed-in document whose billing answer lists nothing still renders as
 * an empty line rather than hiding the figure, so "0" stays visible and a user
 * can tell "exhausted" apart from "not signed in".
 *
 * `unlimited` is carried through instead of being collapsed into `total`: an
 * uncapped enterprise quota and a zero balance are opposite facts that both
 * happen to print a number, so the flag survives to the renderer.
 */
export function buildCreditLine(credits: WorkBuddyWebCredits | undefined): WorkBuddyCreditLine | null {
  if (credits === undefined) return null
  const rows = credits.accounts
    .filter(account => account.remain > 0)
    .slice()
    .sort((a, b) => b.remain - a.remain)
  return {
    total: credits.total,
    rows,
    empty: rows.length === 0 && credits.total === 0 && credits.unlimited !== true,
    unlimited: credits.unlimited === true,
  }
}

/**
 * Resolve the selected WorkBuddy model's billing facts and display name.
 *
 * Returns null for another provider, an unknown model, or an absent catalog —
 * the panel then omits the rate row rather than guessing a price. A row whose
 * rate came from an expired promotion reports `rateUnknown`, and that is
 * surfaced as such instead of being rendered as either the stale figure or
 * "free": the upstream bakes the discounted value into its own field, so the
 * original price is not recoverable from the answer.
 */
export function currentWorkBuddyRate(
  selection: WorkBuddyDockSelection | null | undefined,
  models: readonly WorkBuddyWebModelBadge[] | undefined,
): { rate: string; name: string; unknown: boolean } | null {
  if (selection === null || selection === undefined) return null
  const row = models?.find(model => model.id === selection.model)
  if (row === undefined) return null
  if (row.credits === undefined) {
    return row.rateUnknown === true ? { rate: '', name: row.name, unknown: true } : null
  }
  return { rate: row.credits, name: row.name, unknown: false }
}

/**
 * One piece of the composer line.
 *
 * `copy` pieces go through the host locale (never hard-coded user-facing text);
 * `text` pieces are already-formatted upstream values such as the `x0.79`
 * multiplier, which must not be run through translation.
 */
export type WorkBuddyDockSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'copy'; readonly key: WorkBuddySettingsKey; readonly params?: Readonly<Record<string, string>> }

/** The dock's status-read state machine. */
export type WorkBuddyDockLoad =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly value: WorkBuddyWebStatus }
  | { readonly phase: 'error'; readonly message: string }

/** Everything the dock renders for the current session, in one value. */
export interface WorkBuddyDockLine {
  /**
   * Line pieces, joined by the renderer with a `·` separator. Empty whenever
   * this plugin has no credit figure to show, which is the signal to render
   * nothing at all rather than an empty row.
   */
  readonly segments: readonly WorkBuddyDockSegment[]
  /** Whether the current selection is served by one of this plugin's providers. */
  readonly workbuddy: boolean
  /** The variant serving the selection, or undefined for another provider. */
  readonly variant: WorkBuddyDockVariant | undefined
  /** Credit figures for the details panel, or null when none are readable. */
  readonly credits: WorkBuddyCreditLine | null
  /** The selected model's multiplier, or null when it cannot be determined. */
  readonly rate: { readonly rate: string; readonly name: string; readonly unknown: boolean } | null
}

/**
 * The credit piece of a WorkBuddy line.
 *
 * Every phase produces copy — loading, signed-out and "billing answer missing"
 * each get their own wording — so the row never collapses to nothing while the
 * status document is unusable. That stability is what keeps the composer's
 * layout from shifting as state changes.
 */
function creditSegment(load: WorkBuddyDockLoad, credits: WorkBuddyCreditLine | null): WorkBuddyDockSegment {
  if (credits !== null) {
    return credits.unlimited
      ? { kind: 'copy', key: 'dockCreditUnlimited' }
      : { kind: 'copy', key: 'dockCreditTotal', params: { total: formatCreditTotal(credits.total) } }
  }
  if (load.phase === 'idle' || load.phase === 'loading') return { kind: 'copy', key: 'dockCreditLoading' }
  if (load.phase === 'ok' && load.value.status !== 'signed-in') return { kind: 'copy', key: 'dockCreditSignedOut' }
  return { kind: 'copy', key: 'dockCreditUnavailable' }
}

/**
 * Compose the composer line for whatever the session currently has selected.
 *
 * The line carries the credit figure only. The provider and model are already
 * named by the composer's own model picker directly above this row, so repeating
 * them here would say the same thing twice in adjacent lines; the selection is
 * read solely to decide whether this plugin owns the figure at all.
 *
 * - WorkBuddy selection: the credit state, and nothing else.
 * - Any other provider: no segments. The row keeps its place in the layout but
 *   prints nothing, because this plugin has no figure to show for a model it
 *   does not serve — inventing one, or labelling the row with a foreign
 *   provider, would both be noise.
 * - No selection yet: also empty, for the same reason.
 */
export function buildDockLine(
  projection: WorkBuddyModelSelectionProjection | undefined,
  load: WorkBuddyDockLoad,
): WorkBuddyDockLine {
  const selection = currentModelSelection(projection)
  const variant = selection === null ? undefined : cardVariantFor(selection.provider)
  const workbuddy = variant !== undefined
  const status = load.phase === 'ok' ? load.value : undefined
  const signedIn = status?.status === 'signed-in' ? status : undefined
  const credits = workbuddy ? buildCreditLine(signedIn?.credits) : null
  const rate = workbuddy ? currentWorkBuddyRate(selection, signedIn?.models) : null
  const segments: WorkBuddyDockSegment[] = workbuddy ? [creditSegment(load, credits)] : []
  return { segments, workbuddy, variant, credits, rate }
}

/** Render {@link buildDockLine}'s pieces into the one-line trigger text. */
export function renderDockSegments(
  segments: readonly WorkBuddyDockSegment[],
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string,
): string {
  return segments
    .map(segment => segment.kind === 'text' ? segment.text : t(segment.key, segment.params))
    .join(' · ')
}
