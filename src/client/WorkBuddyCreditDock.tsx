/**
 * The composer credit line: one compact row mounted on
 * `conversation.composer.dock` — the same seat the host's own session-stats
 * strip occupies, so the figure sits directly under the input box beside the
 * token statistics and reads as one family with them.
 *
 * The row carries the remaining credit and nothing else. The provider and model
 * are already named by the composer's own model picker directly above it, so
 * printing them here would duplicate the line above; the multiplier is likewise
 * kept for the details panel, since the picker prints a rate beside each model
 * name. Loading, signed-out and error states each have their own wording so the
 * figure never silently disappears.
 *
 * For any other provider — or before a model is chosen — the component renders
 * nothing at all, leaving the composer its normal spacing, and does not ask this
 * plugin's status route for a model it does not serve.
 *
 * Clicking opens a small menu-surface panel with per-package progress rows, the
 * selected model's multiplier, and a manual refresh.
 *
 * Two props come from the host's session standard kit rather than from this
 * plugin: `conversation.composer.dock` is declared as a plain `list` slot, so
 * the composer passes it no owner values at all (`renderSlot(key, {})`). The
 * session-scoped standard props are merged into every registration inside a
 * session binding by `@deepseek-ai/dsh-client-ui-session`, and that package is
 * therefore a client `inject` in `package.json`. Without it `useProjection` and
 * `useSession` would be absent and this component could not read the selection
 * or notice a turn settling.
 *
 * @module dsh-workbuddy-connect/client/credit-dock
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { isWorkBuddyWebStatus } from './status-document.ts'
import type { WorkBuddyWebCredits, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { buildDockLine, formatCreditTotal, renderDockSegments } from './credit-line.ts'
import type { WorkBuddyDockLoad, WorkBuddyModelSelectionProjection } from './credit-line.ts'

/**
 * Injected copy plus the two session standard hooks.
 *
 * The hooks are typed structurally here so the component stays testable without
 * the full Session snapshot import; `UseProjection`/`UseSession` are the host's
 * own aliases, so a change to their shape still fails this file's typecheck.
 */
export interface WorkBuddyCreditDockProps extends WorkBuddyPluginCardInjected {
  /** Host-computed projection values addressed by projection key. */
  useProjection: UseProjection
  /** Session snapshot selector; only `running` is read. */
  useSession: UseSession
}

/** How often the figure is re-read while a WorkBuddy model is selected. */
const REFRESH_INTERVAL_MS = 60_000

/**
 * Delay after a turn settles before re-reading.
 *
 * Billing is applied upstream when the model request finishes, so the moment a
 * turn ends is when the figure moves — but the upstream's own accounting lands a
 * beat later. Reading immediately would show the pre-turn figure and then not
 * correct it until the next interval.
 */
const SETTLE_DELAY_MS = 2_000

/**
 * The dock's root.
 *
 * Deliberately NOT clipping. The details panel is positioned inside this
 * element, so an `overflow: hidden` here would paint the panel into a clipped
 * box and the click would look like it did nothing. The ellipsis that keeps the
 * credit line to one row lives on {@link lineStyle} instead, which wraps only
 * the text.
 */
const rootStyle: CSSProperties = {
  position: 'relative',
  display: 'block',
  textAlign: 'center',
  maxWidth: 'var(--dsh-chat-content-width, 48rem)',
  width: '100%',
  margin: '0 auto',
  boxSizing: 'border-box',
  padding: '2px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 0px',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** The one-line credit text, ellipsized here rather than on the root. */
const lineStyle: CSSProperties = {
  display: 'block',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const triggerStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
}
/**
 * The details panel, anchored just above the credit row.
 *
 * Absolute positioning inside the unclipped root: the panel is a sibling of the
 * credit line, so it escapes the composer's own row bounds without needing a
 * portal or a measured position.
 */
const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 1000,
  boxSizing: 'border-box',
  width: 264,
  maxHeight: 'min(70vh, 420px)',
  overflowY: 'auto',
  padding: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  fontSize: 12,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
  textAlign: 'left',
  whiteSpace: 'normal',
  cursor: 'default',
}
const panelHeadingStyle: CSSProperties = {
  margin: 0,
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 6,
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}
const panelBigStyle: CSSProperties = {
  fontSize: 20,
  lineHeight: '26px',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-label-primary)',
}
const modelRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 2,
  color: 'var(--dsw-alias-label-secondary)',
}
const rowStyle: CSSProperties = {
  marginTop: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  // The upstream reports every promotional package, so the list can be long; a
  // scrollable body keeps the panel at the context panel's visual scale.
  maxHeight: 180,
  overflowY: 'auto',
}
const rowHeadStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
}
const trackStyle: CSSProperties = {
  height: 4,
  marginTop: 4,
  borderRadius: 999,
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.08))',
  overflow: 'hidden',
}
const emptyNoteStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--dsw-alias-label-tertiary)',
}
const errorStyle: CSSProperties = {
  ...emptyNoteStyle,
  color: 'var(--dsw-alias-state-error-primary, #d92d20)',
}
const footerStyle: CSSProperties = {
  margin: '10px 0 0',
  display: 'flex',
  justifyContent: 'flex-end',
}
const linkStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--dsw-alias-brand-primary, #1677ff)',
}
const sectionTitleStyle: CSSProperties = {
  margin: '10px 0 4px',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.02em',
  color: 'var(--dsw-alias-label-tertiary)',
  textTransform: 'uppercase',
}
const detailRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 12,
  lineHeight: '20px',
}
const detailLabelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  flexShrink: 0,
}
const detailValueStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}
const expiryLineStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
}
const separatorStyle: CSSProperties = {
  margin: '10px 0 0',
  border: 0,
  borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))',
}

/**
 * Format an epoch-ms instant for the details surface.
 *
 * Locale-aware and timezone-stable: the value is shown to the minute, because
 * an expiry stated to the second invites false precision about when credit
 * actually stops being spendable.
 */
function formatLocalTime(epochMs: number, timeZone: string | undefined): string {
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...timeZone === undefined ? {} : { timeZone },
  })
}

/** One label/value row in the account detail block. */
function DetailRow({ label, value, title }: {
  label: string
  value: string
  title?: string
}): React.ReactNode {
  return (
    <div style={detailRowStyle}>
      <span style={detailLabelStyle}>{label}</span>
      <span style={detailValueStyle} {...title === undefined ? {} : { title }}>{value}</span>
    </div>
  )
}

/** Compact per-package progress row. */
function PackageRow({ account, t, timeZone }: {
  account: WorkBuddyWebCredits['accounts'][number]
  t: WorkBuddyCreditDockProps['t']
  timeZone: string | undefined
}): React.ReactNode {
  // A package of unknown size gets no bar rather than a fabricated one.
  const percent = account.size > 0
    ? Math.max(0, Math.min(100, (account.remain / account.size) * 100))
    : null
  return (
    <div>
      <div style={rowHeadStyle}>
        <span>{account.packageName}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {account.unlimited === true
            ? t('unlimitedQuota')
            : account.size > 0
              ? t('exactRemaining', { remain: formatCreditTotal(account.remain), size: formatCreditTotal(account.size) })
              : t('creditPackageUnknownSize', { remain: formatCreditTotal(account.remain) })}
        </span>
      </div>
      {percent === null ? null : (
        <div
          style={trackStyle}
          role="progressbar"
          aria-label={account.packageName}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div style={{ width: `${percent}%`, height: '100%', background: 'var(--dsw-alias-brand-primary, #1677ff)' }} />
        </div>
      )}
      {/* Only stated when the upstream declared a usable date: a package with no
          real expiry must not imply one. */}
      {account.expireAt === undefined ? null : (
        <div style={expiryLineStyle}>{t('dockPackageExpiry', { time: formatLocalTime(account.expireAt, timeZone) })}</div>
      )}
    </div>
  )
}

/**
 * The composer dock entry: reads the session's `modelSelection` projection and
 * hands the current selection to the always-mounted body.
 *
 * There is deliberately no provider gate here. Unmounting on a non-WorkBuddy
 * model would drop the composer's row whenever the user picked another
 * provider; the body instead switches its own behaviour, so the row is present
 * for every provider and only the credit work is WorkBuddy-scoped.
 */
export function WorkBuddyCreditDock({ useProjection, useSession, t }: WorkBuddyCreditDockProps) {
  const selection = useProjection('modelSelection') as WorkBuddyModelSelectionProjection | undefined
  return <WorkBuddyCreditDockBody selection={selection} useSession={useSession} t={t} />
}

/**
 * The dock's stateful half.
 *
 * `useSession` is read once here for `running`, which is what turns a settled
 * turn into an immediate re-read; every other fact comes from the selection and
 * the status route.
 */
function WorkBuddyCreditDockBody({ selection, useSession, t }: {
  selection: WorkBuddyModelSelectionProjection | undefined
  useSession: UseSession
  t: WorkBuddyCreditDockProps['t']
}): React.ReactNode {
  const running = useSession((snapshot: SessionSnapshot) => snapshot.running)
  const [load, setLoad] = useState<WorkBuddyDockLoad>({ phase: 'idle' })
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  // Guards against a slow response for a model the user has already left
  // overwriting a newer read's answer.
  const readSeq = useRef(0)

  const line = buildDockLine(selection, load)
  const statusPath = line.variant?.statusPath

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (path: string, signal?: AbortSignal): Promise<void> => {
    const seq = ++readSeq.current
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // A 200 is not a promise about the body; validate with the same predicate
    // the card and probe control use before storing it in state.
    const value: unknown = await response.json().catch(() => undefined)
    if (!isWorkBuddyWebStatus(value)) throw new Error(t('statusResponseInvalid'))
    if (mounted.current && !signal?.aborted && seq === readSeq.current) setLoad({ phase: 'ok', value })
  }, [t])

  // Credit is a WorkBuddy figure, so the status route is only asked while one of
  // this plugin's models is selected. Switching away tears the interval down,
  // drops the now-meaningless answer back to `idle` and closes the panel — the
  // row itself stays, showing the new provider and model.
  useEffect(() => {
    if (statusPath === undefined) {
      readSeq.current += 1
      setLoad({ phase: 'idle' })
      setOpen(false)
      return
    }
    const controller = new AbortController()
    setLoad({ phase: 'loading' })
    const read = (): void => {
      void refresh(statusPath, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted || !mounted.current) return
        setLoad({ phase: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
      })
    }
    read()
    const timer = window.setInterval(read, REFRESH_INTERVAL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [statusPath, refresh, t])

  // Billing is applied upstream when a request completes, so a turn settling is
  // exactly when the figure moves. Refresh then instead of waiting out the
  // polling interval; the short delay lets the provider finish its accounting.
  const wasRunning = useRef(false)
  useEffect(() => {
    const settled = wasRunning.current && running === false
    wasRunning.current = running === true
    if (!settled || statusPath === undefined) return
    const timer = window.setTimeout(() => {
      void refresh(statusPath).catch(() => { /* the next poll still corrects it */ })
    }, SETTLE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [running, statusPath, refresh])

  // Outside click / Escape close while the panel is up.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // An empty line means this plugin has no figure for the current selection —
  // another provider, or no model chosen yet. Render nothing at all rather than
  // an empty row, so the composer keeps its normal spacing.
  if (line.segments.length === 0) return null
  const lineText = renderDockSegments(line.segments, t)
  const credits = line.credits
  // The signed-in document, once one has arrived: the account detail block is
  // read from here rather than from a second request.
  const signedIn = load.phase === 'ok' && load.value.status === 'signed-in' ? load.value : undefined
  // The host's own timezone, so an expiry reads in the user's clock rather than
  // the browser's guess. Absent in the test environment, where `toLocaleString`
  // falls back to the runtime default.
  const timeZone = typeof Intl.DateTimeFormat === 'function'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined
  // The panel only carries WorkBuddy billing detail, so it stays unreachable
  // (plain text, no dialog affordance) whenever there is none to show.
  if (credits === null) {
    return <div ref={rootRef} style={rootStyle}><span>{lineText}</span></div>
  }

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        type="button"
        style={triggerStyle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('dockPanelAria')}
        onClick={() => { setOpen(!open) }}
      >
        <span style={lineStyle}>{lineText}</span>
      </button>
      {open
        ? (
            <div style={panelStyle} role="dialog" aria-label={t('dockPanelAria')}>
              <div style={panelHeadingStyle}>
                <span>{t('creditsHeading')}</span>
                <span style={panelBigStyle}>
                  {credits.unlimited ? t('unlimitedQuota') : formatCreditTotal(credits.total)}
                </span>
              </div>
              {line.rate === null ? null : (
                <div style={modelRowStyle}>
                  <span>{line.rate.name}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {line.rate.unknown ? t('dockRateUnknown') : t('dockRate', { rate: line.rate.rate })}
                  </span>
                </div>
              )}
              {credits.rows.length > 0
                ? (
                    <div style={rowStyle}>
                      {credits.rows.map((account, index) => (
                        <PackageRow
                          key={`${account.packageName}-${String(index)}`}
                          account={account}
                          t={t}
                          timeZone={timeZone}
                        />
                      ))}
                    </div>
                  )
                : <p style={emptyNoteStyle}>{t('creditEmpty')}</p>}
              {load.phase === 'ok' && load.value.status === 'signed-in' && load.value.creditsError !== undefined
                ? <p style={errorStyle}>{t('creditsError', { message: load.value.creditsError })}</p>
                : null}
              {/* Read-only account detail. This seat has no way to sign in, sign
                  out, or switch accounts — the plugin follows the desktop app's
                  own sign-in — so the block only reports, and every write path
                  stays where it already lives (the settings card). */}
              {signedIn === undefined ? null : (
                <>
                  <hr style={separatorStyle} />
                  <div style={sectionTitleStyle}>{t('dockAccountHeading')}</div>
                  {signedIn.nickname === undefined ? null : (
                    <DetailRow label={t('dockAccountNickname')} value={signedIn.nickname} />
                  )}
                  {signedIn.uid === undefined ? null : (
                    <DetailRow label={t('dockAccountUid')} value={signedIn.uid} title={signedIn.uid} />
                  )}
                  {signedIn.enterpriseAccount === true ? (
                    <DetailRow label={t('dockAccountType')} value={t('dockAccountTypeEnterprise')} />
                  ) : null}
                  {signedIn.domain === undefined ? null : (
                    <DetailRow label={t('dockAccountDomain')} value={signedIn.domain} title={signedIn.domain} />
                  )}
                  {signedIn.expiresAt === undefined ? null : (
                    <DetailRow
                      label={t('dockAccountAccessExpiry')}
                      value={formatLocalTime(signedIn.expiresAt, timeZone)}
                    />
                  )}
                  {signedIn.refreshExpiresAt === undefined ? null : (
                    <DetailRow
                      label={t('dockAccountRefreshExpiry')}
                      value={formatLocalTime(signedIn.refreshExpiresAt, timeZone)}
                    />
                  )}
                  <DetailRow
                    label={t('dockAccountSource')}
                    value={signedIn.source === 'dsh' ? t('dockAccountSourceDsh') : t('dockAccountSourceDesktop')}
                  />
                </>
              )}
              <div style={footerStyle}>
                <button
                  type="button"
                  style={linkStyle}
                  onClick={() => {
                    if (statusPath !== undefined) {
                      void refresh(statusPath).catch(() => { /* the next poll still corrects it */ })
                    }
                  }}
                >
                  {t('refresh')}
                </button>
              </div>
            </div>
          )
        : null}
    </div>
  )
}
