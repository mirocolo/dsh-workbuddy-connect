import { createServer, request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { workBuddyStatusHandler } from '../src/web-status.ts'
import type { WorkBuddyCreditsCacheEntry } from '../src/web-status.ts'
import { WORKBUDDY_STATUS_PATH } from '../src/status-paths.ts'
import type { WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

/** Process-local billing memo the route shares across requests. */
type WorkBuddyCreditsCache = { entry?: WorkBuddyCreditsCacheEntry }

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', nickname: '昵称' },
  })
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function requestOnce(options: {
  port: number
  method: string
  headers: Record<string, string>
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: WORKBUDDY_STATUS_PATH,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function startStatusServer(
  overrides: Partial<WorkBuddyStatusRouteOptions> = {},
  cache?: WorkBuddyCreditsCache,
): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-status-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, nestedDoc(Date.now() + 3600_000))
  const deps: WorkBuddyStatusRouteOptions = {
    store: new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    }),
    client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
    models: () => [],
    ...overrides,
  }
  const server = createServer(workBuddyStatusHandler(deps, cache))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  CLEANUP.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return port
}

describe('context capacity reporting', () => {
  /**
   * The card needs every model's capacity, not only the promoted ones: the
   * models where capacity matters (a 200k model beside 1M siblings) carry no
   * promo, so a payload filtered down to discounts would hide exactly the fact
   * worth showing. The discount list filters at render time instead.
   */
  it('reports capacity for un-promoted models, verbatim and unfiltered', async () => {
    const port = await startStatusServer({
      models: (): readonly WorkBuddyUpstreamModel[] => [
        {
          id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false,
          reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
          billing: { credits: 'x0.79 credits', free: false },
        },
        {
          id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true,
          reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
          billing: { credits: 'x0.00', free: true, badges: ['限时免费'] },
        },
        {
          id: 'plain', name: 'Plain', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true,
          reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
          billing: { free: false },
        },
      ],
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    const body = JSON.parse(response.body) as { models?: readonly { id: string; contextWindow?: number }[] }
    const models = body.models ?? []
    // Verbatim from upstream: no rounding, and no tier of the plugin's own.
    expect(models.find(model => model.id === 'glm-5.1')?.contextWindow).toBe(200_000)
    expect(models.find(model => model.id === 'hy3')?.contextWindow).toBe(192_000)
    // A model with no promo and no rate is still reported: capacity is the one
    // fact the card needs for every model, not just the discounted ones.
    expect(models.find(model => model.id === 'plain')?.contextWindow).toBe(1_000_000)
  })

  it('omits capacity when the upstream number is not usable', async () => {
    const port = await startStatusServer({
      models: (): readonly WorkBuddyUpstreamModel[] => [
        {
          id: 'broken', name: 'Broken', contextWindow: 0, maxTokens: 1_000, supportsImages: false,
          reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
          billing: { free: false },
        },
      ],
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    const body = JSON.parse(response.body) as { models?: readonly { id: string; contextWindow?: number }[] }
    // A non-positive capacity is not reported rather than shown as "0".
    expect(body.models?.find(model => model.id === 'broken')?.contextWindow).toBeUndefined()
  })
})

describe('web status route gate', () => {
  it('serves a same-origin GET without an Origin header', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'signed-in', nickname: '昵称' })
  })

  it('accepts localhost hosts and explicit loopback Origins', async () => {
    const port = await startStatusServer()
    const viaLocalhost = await requestOnce({ port, method: 'GET', headers: { host: `localhost:${String(port)}` } })
    expect(viaLocalhost.status).toBe(200)
    const viaOrigin = await requestOnce({
      port,
      method: 'GET',
      headers: { host: `127.0.0.1:${String(port)}`, origin: `http://127.0.0.1:${String(port)}` },
    })
    expect(viaOrigin.status).toBe(200)
  })

  it('drops a DNS-rebinding style request whose Host is not loopback', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'GET', headers: { host: 'evil.example:3080' } })
    expect(response.status).toBe(403)
  })

  it('drops a request whose Origin is not loopback even on a loopback Host', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({
      port,
      method: 'GET',
      headers: { host: `127.0.0.1:${String(port)}`, origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
  })

  it('answers 405 for non-GET methods', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'POST', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(405)
  })
})

describe('maximum-context preference capability', () => {
  /**
   * The field's presence is the card's capability signal: the host includes it
   * only when the preference can actually be persisted, so a host whose
   * settings service lost the 0.1.2-era section API (DSH 0.1.7) answers
   * `undefined` from the getter and the document stays silent — the card then
   * renders no preference control at all.
   */
  it('carries the field when the getter answers a value', async () => {
    const port = await startStatusServer({
      probe: () => ({ consent: true, running: false, candidates: [], results: [] }),
      useMaximumContextWindow: () => true,
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    const document = JSON.parse(response.body) as Record<string, unknown>
    expect(document['useMaximumContextWindow']).toBe(true)
  })

  it('omits the field when the getter answers undefined, keeping the rest of the document', async () => {
    const port = await startStatusServer({
      probe: () => ({ consent: true, running: false, candidates: [], results: [] }),
      useMaximumContextWindow: () => undefined,
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    const document = JSON.parse(response.body) as Record<string, unknown>
    expect(document).not.toHaveProperty('useMaximumContextWindow')
    expect(document).toHaveProperty('probe')
  })
})

describe('billing memo', () => {
  /**
   * The settings card and the composer's credit line poll this route
   * independently. Without a memo each poll is a live billing call upstream, so
   * two pollers double that endpoint's traffic for a figure that only moves
   * when the user spends. These pin the collapse and, just as importantly, the
   * cases where the memo must NOT be trusted.
   */
  it('collapses two polls inside the window into one upstream call', async () => {
    let calls = 0
    const cache: WorkBuddyCreditsCache = {}
    const port = await startStatusServer({
      client: {
        fetchCredits: async () => {
          calls += 1
          return { total: 1_000, accounts: [] }
        },
      },
    }, cache)

    const first = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    const second = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })

    expect(calls).toBe(1)
    // Both callers still receive the figure: a memo hit is invisible to them.
    expect((JSON.parse(first.body) as { credits?: { total: number } }).credits?.total).toBe(1_000)
    expect((JSON.parse(second.body) as { credits?: { total: number } }).credits?.total).toBe(1_000)
  })

  it('calls the upstream again once the window has passed', async () => {
    let calls = 0
    const cache: WorkBuddyCreditsCache = {}
    const port = await startStatusServer({
      client: {
        fetchCredits: async () => {
          calls += 1
          return { total: calls, accounts: [] }
        },
      },
    }, cache)

    await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    // Age the entry past the TTL rather than waiting: the point under test is
    // the expiry comparison, not the passage of real time.
    cache.entry = { at: Date.now() - 60_000, credits: { total: 1, accounts: [] } }
    const response = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })

    expect(calls).toBe(2)
    expect((JSON.parse(response.body) as { credits?: { total: number } }).credits?.total).toBe(2)
  })

  it('does not memoize a failure over a later success', async () => {
    // A failed read must not be cached: otherwise a transient upstream error
    // would keep being served after the upstream recovered.
    let calls = 0
    const cache: WorkBuddyCreditsCache = {}
    const port = await startStatusServer({
      client: {
        fetchCredits: async () => {
          calls += 1
          if (calls === 1) throw new Error('upstream exploded')
          return { total: 42, accounts: [] }
        },
      },
    }, cache)

    const failed = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    expect((JSON.parse(failed.body) as { creditsError?: string }).creditsError).toContain('upstream exploded')
    expect(cache.entry).toBeUndefined()

    const recovered = await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    expect((JSON.parse(recovered.body) as { credits?: { total: number } }).credits?.total).toBe(42)
    expect(cache.entry?.credits.total).toBe(42)
  })

  it('stays live when no memo is supplied', async () => {
    // The route is mounted with a memo, but `workBuddyWebStatus`/the handler
    // keep working without one so a caller can still force a live read.
    let calls = 0
    const port = await startStatusServer({
      client: {
        fetchCredits: async () => {
          calls += 1
          return { total: 7, accounts: [] }
        },
      },
    })

    await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    await requestOnce({ port, method: 'GET', headers: { host: '127.0.0.1' } })
    expect(calls).toBe(2)
  })

  it('keeps each product\'s answer in its own memo', async () => {
    // The two desktop products have separate accounts and separate balances, so
    // a shared memo would report one product's credit under the other's route.
    // Each mount owns its memo, which is what this pins.
    const cn: WorkBuddyCreditsCache = {}
    const ai: WorkBuddyCreditsCache = {}
    const portOf = async (cache: WorkBuddyCreditsCache, total: number): Promise<number> =>
      await startStatusServer({
        client: { fetchCredits: async () => ({ total, accounts: [] }) },
      }, cache)

    const cnPort = await portOf(cn, 111)
    const aiPort = await portOf(ai, 222)

    const cnBody = JSON.parse((await requestOnce({ port: cnPort, method: 'GET', headers: { host: '127.0.0.1' } })).body) as { credits?: { total: number } }
    const aiBody = JSON.parse((await requestOnce({ port: aiPort, method: 'GET', headers: { host: '127.0.0.1' } })).body) as { credits?: { total: number } }

    expect(cnBody.credits?.total).toBe(111)
    expect(aiBody.credits?.total).toBe(222)
    expect(cn.entry?.credits.total).toBe(111)
    expect(ai.entry?.credits.total).toBe(222)
  })
})
