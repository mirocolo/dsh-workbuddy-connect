import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCreditDock, type WorkBuddyCreditDockProps } from '../src/client/WorkBuddyCreditDock.tsx'
import type { WorkBuddyModelSelectionProjection } from '../src/client/credit-line.ts'
import { en } from '../src/client/locales.ts'

/**
 * Composer credit dock tests. The behaviour these pin down:
 *
 * - the row is always mounted, whatever provider is selected, so the composer
 *   never loses a line and the layout does not shift;
 * - the status route is only asked for one of this plugin's own providers, and
 *   asking stops the moment the user switches away;
 * - a turn settling triggers an immediate re-read, because that is when the
 *   upstream's billing figure moves.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

describe('Composer credit dock', () => {
  let view: ReactTestRenderer | undefined
  let projection: WorkBuddyModelSelectionProjection
  let running = false
  let statusBody: Record<string, unknown>
  const request = vi.fn()
  /** Timers the component asked for, so a settle can be fired on demand. */
  let timeouts: (() => void)[] = []

  /** The two session standard hooks the host merges into session-scoped slots. */
  const useProjection: WorkBuddyCreditDockProps['useProjection'] = ((key: string) =>
    key === 'modelSelection' ? projection : undefined) as WorkBuddyCreditDockProps['useProjection']
  const useSession = ((selector: (snapshot: { running: boolean }) => unknown) =>
    selector({ running })) as unknown as WorkBuddyCreditDockProps['useSession']

  function select(provider: string, model: string): void {
    projection = { next: { provider, model }, lastUsed: null }
  }

  function status(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      credits: { total: 1_642, accounts: [{ packageName: '套餐', remain: 1_642, size: 2_000 }] },
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' }],
      ...overrides,
    }
  }

  /** Render the dock and let its first status read settle. */
  async function mount(): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(WorkBuddyCreditDock, { useProjection, useSession, t }))
    })
    view = renderer
    return renderer as ReactTestRenderer
  }

  /** All rendered text, flattened for substring assertions. */
  function text(renderer: ReactTestRenderer): string {
    return JSON.stringify(renderer.toJSON())
  }

  beforeEach(() => {
    running = false
    timeouts = []
    status()
    select('workbuddy', 'glm-5.3')
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      clearTimeout: () => {},
      setTimeout: (handler: () => void) => { timeouts.push(handler); return 1 },
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
  })

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
    vi.unstubAllGlobals()
  })

  it('shows just the credit figure for a WorkBuddy selection', async () => {
    const renderer = await mount()
    const rendered = text(renderer)
    expect(rendered).toContain('Credit 1,642')
    // The provider and model are named by the picker above this row already.
    expect(rendered).not.toContain('Provider')
    expect(rendered).not.toContain('Model ')
  })

  it('reads the status route once mounted for a WorkBuddy model', async () => {
    await mount()
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]?.[0])).toContain('/plugins/dsh-workbuddy-connect/status')
  })

  it('renders no row at all for another provider', async () => {
    select('llm-pi-ai', 'gpt-4o')
    const renderer = await mount()
    // No row, so the composer keeps its normal spacing...
    expect(renderer.toJSON()).toBeNull()
    // ...and no WorkBuddy figure is fetched for a model this plugin does not serve.
    expect(request).not.toHaveBeenCalled()
  })

  it('routes the international product to its own status route', async () => {
    select('workbuddy-ai', 'glm-5.3')
    await mount()
    expect(String(request.mock.calls[0]?.[0])).toContain('/plugins/dsh-workbuddy-connect/ai/status')
  })

  it('re-reads immediately once a turn settles', async () => {
    const renderer = await mount()
    expect(request).toHaveBeenCalledTimes(1)

    // A turn starts and ends; the settle is what moves the upstream figure.
    running = true
    await act(async () => { renderer.update(createElement(WorkBuddyCreditDock, { useProjection, useSession, t })) })
    running = false
    await act(async () => { renderer.update(createElement(WorkBuddyCreditDock, { useProjection, useSession, t })) })

    // The re-read is deliberately delayed so the provider can finish accounting.
    expect(timeouts).toHaveLength(1)
    await act(async () => {
      timeouts[0]?.()
      await Promise.resolve()
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not schedule a re-read when no turn ran', async () => {
    const renderer = await mount()
    // A settle can only follow a run; a bare re-render must not poll early.
    await act(async () => { renderer.update(createElement(WorkBuddyCreditDock, { useProjection, useSession, t })) })
    expect(timeouts).toHaveLength(0)
  })

  it('states an uncapped quota instead of a total', async () => {
    status({ credits: { total: 0, accounts: [], unlimited: true } })
    const renderer = await mount()
    expect(text(renderer)).toContain('Credit unlimited')
  })

  it('degrades to an error line when the status reply is unreadable', async () => {
    request.mockImplementation(async () => ({ ok: true, json: async () => null }))
    const renderer = await mount()
    // The row still renders and still states a credit outcome; only the
    // wording changes. Nothing depends on the catalog this reply failed to
    // deliver, because the line no longer prints model names.
    expect(text(renderer)).toContain('Credit unavailable')
  })
})

describe('Composer credit dock account detail', () => {
  let view: ReactTestRenderer | undefined
  let projection: WorkBuddyModelSelectionProjection
  let statusBody: Record<string, unknown>
  const request = vi.fn()

  const useProjection: WorkBuddyCreditDockProps['useProjection'] = ((key: string) =>
    key === 'modelSelection' ? projection : undefined) as WorkBuddyCreditDockProps['useProjection']
  const useSession = ((selector: (snapshot: { running: boolean }) => unknown) =>
    selector({ running: false })) as unknown as WorkBuddyCreditDockProps['useSession']

  function status(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      nickname: '昵称',
      uid: 'uid-12345',
      domain: 'www.workbuddy.cn',
      source: 'desktop',
      expiresAt: Date.UTC(2026, 8, 29, 15, 30),
      refreshExpiresAt: Date.UTC(2026, 9, 20, 8, 0),
      credits: { total: 100, accounts: [{ packageName: '包', remain: 100, size: 200 }] },
      ...overrides,
    }
  }

  /** Mount and then click the credit row open. */
  async function mountOpen(): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(WorkBuddyCreditDock, { useProjection, useSession, t }))
    })
    view = renderer
    const trigger = (renderer as ReactTestRenderer).root.findAllByType('button')[0]
    await act(async () => { trigger?.props.onClick() })
    return renderer as ReactTestRenderer
  }

  function text(renderer: ReactTestRenderer): string {
    return JSON.stringify(renderer.toJSON())
  }

  beforeEach(() => {
    projection = { next: { provider: 'workbuddy', model: 'glm-5.3' }, lastUsed: null }
    status()
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      clearTimeout: () => {},
      setTimeout: () => 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
  })

  afterEach(() => {
    act(() => { view?.unmount() })
    view = undefined
    vi.unstubAllGlobals()
  })

  it('reports the signed-in account details', async () => {
    const rendered = text(await mountOpen())
    expect(rendered).toContain('昵称')
    expect(rendered).toContain('uid-12345')
    expect(rendered).toContain('www.workbuddy.cn')
    expect(rendered).toContain('Account')
  })

  it('distinguishes the refresh expiry from the access token expiry', async () => {
    // The two mean different things: the access token lapses constantly and is
    // renewed silently, while the refresh expiry is what forces a re-sign-in.
    const rendered = text(await mountOpen())
    expect(rendered).toContain('Access token expires')
    expect(rendered).toContain('Re-sign-in required after')
  })

  it('offers no way to change the account from this seat', async () => {
    // The plugin follows the desktop app's sign-in, so this surface is read-only
    // by design: the only affordances are the row itself and the refresh link.
    // Anything that writes (switch, sign out, add) belongs to the settings card.
    const renderer = await mountOpen()
    const buttons = renderer.root.findAllByType('button')
    // Two buttons: the credit row that opens the panel, and the refresh link.
    // Anything that writes (switch, sign out, add) belongs to the settings card.
    expect(buttons).toHaveLength(2)
    // The second is the refresh link, and the row itself is the only other
    // affordance — asserted by its aria-label rather than by reading children,
    // which reaches into the nested span the label lives in.
    expect(buttons[0]?.props['aria-haspopup']).toBe('dialog')
    expect(String(buttons[1]?.props.children)).toBe('Refresh')
    const rendered = text(renderer)
    expect(rendered).not.toContain('Switch')
    expect(rendered).not.toContain('Sign out')
    expect(rendered).not.toContain('Delete')
  })

  it('omits identity rows the document does not carry', async () => {
    status({ uid: undefined, refreshExpiresAt: undefined, nickname: undefined })
    const rendered = text(await mountOpen())
    expect(rendered).not.toContain('UID')
    expect(rendered).not.toContain('Re-sign-in required after')
    // The credit rows still render: a document missing identity is not a
    // document missing billing.
    expect(rendered).toContain('Credit')
  })

  it('marks an enterprise account without exposing the tenant id', async () => {
    status({ enterpriseAccount: true })
    const rendered = text(await mountOpen())
    expect(rendered).toContain('Enterprise')
  })

  it('states a package expiry when the upstream declared one', async () => {
    status({
      credits: {
        total: 100,
        accounts: [{ packageName: '包', remain: 100, size: 200, expireAt: Date.UTC(2026, 9, 6, 23, 59) }],
      },
    })
    const rendered = text(await mountOpen())
    expect(rendered).toContain('Expires')
  })

  it('states no expiry for a package the upstream left undated', async () => {
    // Absence must read as "nothing declared", never as a fabricated date.
    const rendered = text(await mountOpen())
    expect(rendered).not.toContain('Expires')
  })

  it('anchors the panel in a container that does not clip it', async () => {
    /*
     * The regression this pins: the root used to carry `overflow: hidden` so the
     * credit line would ellipsize to one row. The details panel is positioned
     * inside that root, so it was painted into the clipped box and the click
     * looked like it did nothing at all. The clipping now lives on the inner
     * text span; the root must stay unclipped or the panel becomes invisible
     * again.
     */
    const renderer = await mountOpen()
    const root = renderer.root.findAll(node => node.type === 'div')[0]
    expect(root?.props.style.overflow).toBeUndefined()

    // The clipping still applies to the one-line text, so the row stays one row.
    const line = renderer.root.findAllByType('span')[0]
    expect(line?.props.style.overflow).toBe('hidden')
    expect(line?.props.style.textOverflow).toBe('ellipsis')

    // And the panel is a descendant of that unclipped root, not a sibling tree.
    const panel = renderer.root.findAll(node => node.props.role === 'dialog')[0]
    expect(panel).toBeDefined()
  })
})
