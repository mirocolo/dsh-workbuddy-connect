import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUNDLE_NAME } from '../src/client/index.tsx'

/**
 * Guard the module-identity contract between this package's three names.
 *
 * Renaming a package is a one-line change in `package.json`, but two other
 * places spell the name as a *module specifier* the host resolves, and both
 * fail in ways that are nearly invisible:
 *
 * - `cordis.patch.yml`'s `name` is what the Loader passes to `import()`. On a
 *   mismatch the import throws `ERR_MODULE_NOT_FOUND`, the Loader swallows it
 *   into the host log, and the entry's fiber is never created — the only
 *   symptom is the opaque `failed to import` in the Plugins UI.
 * - `BUNDLE_NAME` is the `plugins.bundle.config` key the Plugins page
 *   dispatches by package name. On a mismatch there is no error at all; the
 *   configuration entry simply never renders.
 *
 * Both were wrong after this package moved to the `@mirocolo` scope, so this
 * test pins them to `package.json` rather than to a literal.
 */
describe('package name identity', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name: string }

  it('cordis.patch.yml registers the plugin under package.json\'s name', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    // Read the `name:` of the inserted entry without pulling in a YAML parser:
    // the file is a small, fixed shape and this keeps the test dependency-free.
    const names = [...patch.matchAll(/^\s*name:\s*(.+?)\s*$/gm)]
      .map(match => match[1]!.replace(/^['"]|['"]$/g, ''))
    expect(names).toContain(pkg.name)
  })

  it('the client bundle key is package.json\'s name', () => {
    expect(BUNDLE_NAME).toBe(pkg.name)
  })
})
