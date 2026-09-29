import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/** The package manifest, read once: both the bundle id and the version come from it. */
const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

/**
 * The id the browser bundle registers itself under.
 *
 * Taken from `package.json` rather than written as a literal: the host's module
 * loader matches this id against the package name it resolved, so a rename that
 * misses this one place produces a *silent* client-side failure —
 * `__ModuleLoader__.load` completes, but the host rejects it with
 * "loaded without registering <name>" because the two ids disagree.
 */
const PLUGIN_ID = PACKAGE.name

/** Build-time define map; `src/version.ts` reads `__DSH_WORKBUDDY_VERSION__`. */
const VERSION_DEFINE = { __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE.version) }

/**
 * Modules the host loader provides, kept out of the browser bundle. The
 * client's DSH imports are type-only today — they erase at build time, so the
 * emitted bundle only requires React. The list is the guardrail that keeps a
 * future value import `require`d from the host instead of inlined.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
