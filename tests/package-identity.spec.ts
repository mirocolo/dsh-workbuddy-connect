import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUNDLE_NAME } from '../src/client/index.tsx'
import { WORKBUDDY_REPOSITORY_URL, WORKBUDDY_UPDATE_PACKAGE_NAME } from '../src/update.ts'

/**
 * Guard the module-identity contract between this package's names.
 *
 * Renaming a package is a one-line change in `package.json`, but three other
 * places spell the name as a *module id* the host resolves, and each fails in
 * its own nearly invisible way:
 *
 * - `cordis.patch.yml`'s `name` is what the Loader passes to `import()`. On a
 *   mismatch the import throws `ERR_MODULE_NOT_FOUND`, the Loader swallows it
 *   into the host log, and the entry's fiber is never created — the only
 *   symptom is the opaque `failed to import` in the Plugins UI. It is also
 *   invisible in the desktop app's DevTools, because it happens in the host
 *   process rather than the Electron renderer.
 * - `BUNDLE_NAME` is the `plugins.bundle.config` key the Plugins page
 *   dispatches by package name. On a mismatch nothing is raised; the
 *   configuration entry simply never renders.
 * - the banner id in the built `lib/client.js` (`__ModuleLoader__.load({ id })`)
 *   is matched by the host against the resolved package name. On a mismatch the
 *   browser bundle loads and then is rejected with "loaded without registering
 *   <name>", which reads like a bundling fault rather than a rename miss.
 *
 * All three were wrong after this package moved to the `@mirocolo` scope, so
 * this test pins them to `package.json` rather than to a literal.
 */
describe('package name identity', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name: string, repository: { url: string } }

  it('cordis.patch.yml registers the plugin under package.json\'s name', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    // Read the `name:` values without pulling in a YAML parser: the file is a
    // small, fixed shape and this keeps the test dependency-free.
    const names = [...patch.matchAll(/^\s*name:\s*(.+?)\s*$/gm)]
      .map(match => match[1]!.replace(/^['"]|['"]$/g, ''))
    expect(names).toContain(pkg.name)
  })

  it('the client bundle key is package.json\'s name', () => {
    expect(BUNDLE_NAME).toBe(pkg.name)
  })

  it('the built client bundle registers itself under package.json\'s name', () => {
    const bundle = new URL('../lib/client.js', import.meta.url)
    // Skipped when nothing has been built yet, matching tests/version.spec.ts.
    if (!existsSync(bundle)) return
    const source = readFileSync(bundle, 'utf8')
    const registered = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1]
    expect(registered, 'lib/client.js has no __ModuleLoader__.load banner').toBeDefined()
    expect(registered).toBe(pkg.name)
  })

  /**
   * The update checker points at the *fork's* repository and npm package.
   *
   * These are the fork's own identity rather than a copy of `package.json`, so
   * they are asserted explicitly: left pointing at upstream they would not
   * break anything visibly, they would quietly offer another maintainer's
   * releases — versions this package never published — as upgrades.
   */
  it('the update checker targets this fork, not upstream', () => {
    expect(WORKBUDDY_UPDATE_PACKAGE_NAME).toBe(pkg.name)
    expect(WORKBUDDY_REPOSITORY_URL).toBe(pkg.repository.url.replace(/^git\+|\.git$/g, ''))
  })
})
