/**
 * Test doubles for the DSH `settings` service.
 *
 * Shared because more than one suite needs a settings service present: the
 * plugin's settings wiring is feature-detected, so a suite that only cares
 * about catalog behaviour still has to install one to exercise the wired path.
 */

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

/**
 * A stand-in for DSH 0.1.7's `SettingsForms` service.
 *
 * The real service is derived from the Cordis Loader: it reads the active
 * profile's patch document and validates writes against each entry's exported
 * `Config`. It therefore cannot be instantiated standalone — its `inject` list
 * (`configEditor`, `profileContext`) names services only the full DSH
 * application provides. This double reproduces exactly the parts the plugin
 * depends on:
 *
 * - forms are keyed by the owning Loader entry id (`llm-workbuddy`), not by a
 *   settings namespace. That is the 0.1.7 contract the plugin's
 *   `setMaximumContextWindow` path writes through, and keeping it here means a
 *   regression back to the removed 0.1.6 namespace API fails loudly;
 * - `update()` does the two things the Loader does in response to an edit: it
 *   re-resolves the owning entry's config, so the plugin's next read sees the
 *   new value, and it announces `loader/volatile-update`, which is the signal
 *   the plugin re-points its stores from.
 */
export class MemorySettingsForms extends Service {
  static inject: string[] = []
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}
  /** The config object the plugin's `apply()` received, re-resolved on edit. */
  private entry: { config?: unknown } | undefined

  constructor(ctx: Context) {
    // The first argument is the service key: naming it `settings` is what
    // makes this instance the `ctx.settings` the plugin injects, exactly as
    // the real `SettingsForms` does.
    super(ctx, 'settings')
  }

  /** Bind the config object the Loader parsed for this entry. */
  bindEntry(entry: { config?: unknown }): void {
    this.entry = entry
  }

  /** The stored form values for one entry id. */
  get(ns: string): unknown {
    return this.storedDocument[ns]
  }

  /** The entry ids with a form, mirroring what `describe()` reports. */
  describe(): { ns: string }[] {
    return Object.keys(this.storedDocument).map(ns => ({ ns }))
  }

  update(ns: string, patch: Record<string, unknown>): Promise<void> {
    const existing = (this.storedDocument[ns] ?? {}) as Record<string, unknown>
    this.storedDocument[ns] = { ...existing, ...patch }
    // Write into the *plugin's* config object, which is what the real Loader
    // re-resolves. It must be the live object rather than a copy: the plugin
    // closes over the config it was applied with, so a fresh object would leave
    // it reading stale values.
    const config = this.boundConfig()
    if (config !== undefined) {
      for (const [key, value] of Object.entries(patch)) {
        const reference = (config as Record<string, unknown>)[key]
        if (isVolatile(reference)) {
          // A `.volatile()` field parses into a stable reference read with
          // `.get()`. An edit commits a fresh snapshot into it, which is what
          // the Loader does when it re-parses the edited entry — `updateVolatile`
          // is the supported way to do that (a `Volatile` exposes only `get()`).
          updateVolatile(reference, createVolatile(value))
        } else {
          ;(config as Record<string, unknown>)[key] = value
        }
      }
    }
    // `loader/volatile-update` is a real Loader event but is not declared in the
    // public event map, so it is emitted through a structural view — the same
    // reason the plugin subscribes to it that way.
    ;(this.ctx as unknown as { emit(event: string, ...args: unknown[]): void })
      .emit('loader/volatile-update', [])
    return Promise.resolve()
  }

  /**
   * The config object the plugin under test holds.
   *
   * Bound explicitly when a test needs a specific object (a file-backed boot
   * re-resolves its own); otherwise discovered through `ctx.registry`, which is
   * how the real Loader addresses an entry — this plugin is the only registered
   * one whose config carries the `authFileAI` field, which identifies it
   * without depending on load order.
   */
  private boundConfig(): Record<string, unknown> | undefined {
    if (this.entry?.config !== undefined) return this.entry.config as Record<string, unknown>
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        const config = (fiber as unknown as { config?: Record<string, unknown> }).config
        if (config !== undefined && 'authFileAI' in config) {
          this.entry = { config }
          return config
        }
      }
    }
    return undefined
  }
}

/**
 * The same double, backed by a JSON file so a restart can be simulated.
 *
 * Mirrors {@link MemorySettingsForms}; only the storage differs. The file is
 * the "profile patch" the Loader would re-read on the next boot.
 */
export class FileSettingsForms extends MemorySettingsForms {
  constructor(ctx: Context, private readonly documentPath: string) {
    super(ctx)
  }

  override get(ns: string): unknown {
    return this.readDocument()[ns]
  }

  override async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    const document = this.readDocument()
    const existing = (document[ns] ?? {}) as Record<string, unknown>
    document[ns] = { ...existing, ...patch }
    await writeFile(this.documentPath, JSON.stringify(document))
    await super.update(ns, patch)
  }

  private readDocument(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.documentPath, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}
