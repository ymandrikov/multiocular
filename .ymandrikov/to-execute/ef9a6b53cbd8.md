# Issue #55 Yarn Lockfile Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse Yarn grouped descriptors, aliases, and locators into stable requested and resolved identities, then emit one public dependency identity per Yarn lockfile.

**Architecture:** A small pure `server/loader/versions/yarn-identity.ts` module parses grouped lockfile keys and selects the canonical resolved name. `server/loader/versions/yarn.ts` keeps format parsing, warning emission, git effective-version handling, per-lockfile aggregation, directness calculation, and `Dependency` construction. All new tests exercise the public `yarn.load()` interface.

**Tech Stack:** TypeScript, Node.js `node:test` through `better-node-test` (`pnpm bnt`), the existing `yaml` parser, and the existing Yarn versions-loader interfaces.

## Global Constraints

- Do not add dependencies.
- Never change `eslint.config.ts`; fix code instead.
- Never use `as any`.
- Import only specific functions, merge type and value imports from the same module, use `.ts` in local imports, and do not introduce a default export.
- Prefer short one-word variable names without abbreviations, do not create a variable used in only one place, and do not add comments to generated code.
- Use discriminated unions like `{ missing: true } | { missing: false; content: string }` instead of `{ missing: boolean; content?: string }`.
- Brand only the exported domain values (`YarnRequestedName`, `YarnResolvedName`). Module-internal parsing uses plain strings.
- Per `server/AGENTS.md`: avoid unit tests, use only integration tests, and do not write tests for small helpers. Every new test calls `yarn.load()`; do not create a direct test file for `resolveYarnIdentity`.
- Keep `splitPackage`, `server/loader/versions/common.ts`, and every non-Yarn loader unchanged.
- Use deterministic in-memory fixtures. No network, no yarn binary.
- Before `pnpm test`, run `./scripts/format.sh` and `pnpm test:types` in that order.

---

**Status:** Approved; ready to execute

**Date:** 2026-07-14

**Issue:** https://github.com/ai/multiocular/issues/55

**Supersedes for execution:**

- `.ymandrikov/plans/issue-55-yarn-lockfile-identity-plan.md`
- `.ymandrikov/plans/issue-55-yarn-identity-staged-plan.md`

## Problem

Yarn Berry and Yarn 1 can serialize multiple descriptors resolving to one package as a comma-separated lockfile key:

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

Both current Yarn parsers pass that collection to `splitPackage`, whose contract is one coordinate. Its final-`@` search crosses the descriptor boundary and produces the malformed name `caniuse-lite@^1.0.30001702, caniuse-lite`, which breaks direct-dependency detection and produces a 404 from the npm registry during diff loading.

The defect is in the Yarn loader. Grouped keys, descriptor quoting, npm aliases, and Berry locators are Yarn serialization concepts and must not widen the shared `splitPackage` contract.

## Identity Rules

The outer Yarn grammar is `ident@reference`. The separator is the first `@` after an optional leading scope marker. For an ordinary descriptor the requested name and the target name are the same ident. For an npm alias like `my-alias@npm:lodash@^4.0.0` the requested name is `my-alias` and the target is `lodash`.

- **Requested names** (every outer ident in the grouped key) determine directness against `package.json`.
- **Resolved name** determines diff identity, display, repository lookup, and npm tarball loading:
  - Berry: the `resolution` locator's outer ident is authoritative. If `resolution` is missing or does not parse, fall back to the classic rule.
  - Classic (and Berry fallback): use the descriptor target only when every target in the group agrees. Never infer a name from `resolved` registry URLs.
- Any unparseable member or disagreeing targets invalidate the whole entry. The loader skips it with one generic warning containing the source path and the raw key. Other entries in the file continue loading.
- Existing git effective-version behavior is unchanged: when the entry's resolution text contains `github.com` or `git+`, that text remains the version.
- After identity selection, the loader coalesces equal `(resolved name, effective version)` identities within each source lockfile, unions their requested names, and derives directness from the union. Aggregation never crosses lockfile boundaries. `type` stays the hardcoded `'npm'` at construction and is not part of the key.
- `Dependency`, `Change`, `calculateVersionDiff`, and all downstream contracts are unchanged. Requested names and locators stay internal to the Yarn loader.

The first commit may still emit duplicate public identities from separate lock entries (for example a Yarn 1 alias and its target serialized separately); the second commit completes the contract. The commits are independently reviewable but form one release.

## Architecture

| File | Responsibility |
|---|---|
| `server/loader/versions/yarn-identity.ts` | Pure grouped-key, coordinate, alias-target, and Berry-locator parsing; no logging |
| `server/loader/versions/yarn.ts` | Yarn 1/Berry format parsing, warnings, effective versions, per-lockfile aggregation, directness, `Dependency` construction |
| `server/test/yarn.test.ts` | Offline `yarn.load()` fixtures for both formats: identity, aliases, warnings, directness, git versions, aggregation |
| `server/test/yarn1.test.ts` | Existing real Yarn 1 end-to-end coverage; unchanged |
| `server/test/yarn-berry.test.ts` | Existing real Berry end-to-end coverage; unchanged |

No other production or test file changes.

## Task 1: Structural Identity Parser and Loader Integration

**Files:**

- Create: `server/loader/versions/yarn-identity.ts`
- Create: `server/test/yarn.test.ts`
- Modify: `server/loader/versions/yarn.ts`

**Interfaces:**

- Consumes: `Brand`, `Dependency`, `dependencyType`, `loadedFile` from `common/types.ts`; `VersionsLoader`, `getDirectDependencies`, `separateFiles` from `./common.ts`; `warn(message: string, extra?: string)` from `server/cli/print.ts`; `parse` from `yaml`.
- Produces: `resolveYarnIdentity(input: YarnIdentityInput): YarnIdentityResult`, exported types `YarnText`, `YarnRequestedName`, `YarnResolvedName`, and one `Dependency` per valid lock entry.
- Preserves: first-seen entry order, git effective versions, public `Dependency` shape, `splitPackage`, and all non-Yarn behavior.

- [ ] **Step 1: Write failing loader tests**

Create `server/test/yarn.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadedFile } from '../../common/types.ts'
import { yarn } from '../loader/versions/yarn.ts'

test('loads the grouped Berry issue fixture', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { 'caniuse-lite': '^1.0.30001702' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746":',
          '  version: 1.0.30001750',
          '  resolution: "caniuse-lite@npm:1.0.30001750"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'caniuse-lite',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.30001750'
      }
    ]
  )
})

test('loads grouped quoted scoped Yarn 1 descriptors', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          '"@scope/pkg@^1.0.0", "@scope/pkg@^2.0.0":',
          '  version "2.1.0"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: '@scope/pkg',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '2.1.0'
      }
    ]
  )
})

test('uses a Berry locator and alias directness', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { 'my-alias': 'npm:lodash@^4.0.0' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"lodash@npm:^4.0.0, my-alias@npm:lodash@^4.0.0":',
          '  version: 4.17.21',
          '  resolution: "lodash@npm:4.17.21"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'lodash',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '4.17.21'
      }
    ]
  )
})

test('uses a Yarn 1 alias target and alias directness', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { 'my-alias': 'npm:lodash@^4.0.0' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          'my-alias@npm:lodash@^4.0.0:',
          '  version "4.17.21"',
          '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'lodash',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '4.17.21'
      }
    ]
  )
})

test('uses locator authority and missing-locator fallback', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"first@npm:^1.0.0, second@npm:^2.0.0":',
          '  version: 3.0.0',
          '  resolution: "installed@npm:3.0.0"',
          '"fallback@npm:^1.0.0, fallback@npm:^2.0.0":',
          '  version: 2.0.0'
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'installed',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '3.0.0'
      },
      {
        direct: false,
        from: 'yarn',
        name: 'fallback',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '2.0.0'
      }
    ]
  )
})

test('falls back to agreed targets after an unparseable locator', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"pkg@npm:^1.0.0, pkg@npm:^2.0.0":',
          '  version: 1.0.0',
          '  resolution: "invalid"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'pkg',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      }
    ]
  )
})

test('preserves an existing git effective version', () => {
  let resolution = 'pkg@git@github.com:owner/repository.git#commit=abc'
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"pkg@git:github.com/owner/repository.git#commit=abc":',
          '  version: 1.0.0',
          `  resolution: "${resolution}"`
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'pkg',
        source: '/project/yarn.lock',
        type: 'npm',
        version: resolution
      }
    ]
  )
})

test('warns and excludes unparseable or ambiguous entries', context => {
  let warning = ''
  context.mock.method(
    process.stderr,
    'write',
    (value: string | Uint8Array): boolean => {
      warning += value.toString()
      return true
    }
  )

  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          'first@npm:one@^1.0.0, second@npm:two@^1.0.0:',
          '  version "1.0.0"',
          'pkg@^1.0.0, broken:',
          '  version "1.0.0"',
          'fine@^1.0.0:',
          '  version "1.0.0"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'fine',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      }
    ]
  )
  assert.match(warning, /\/project\/yarn\.lock/)
  assert.match(warning, /first@npm:one@/)
  assert.match(warning, /pkg@\^1\.0\.0, broken/)
})
```

- [ ] **Step 2: Run a focused test and verify it fails**

Run:

```sh
pnpm bnt server/test/yarn.test.ts -t 'loads the grouped Berry issue fixture'
```

Expected: FAIL because the current loader passes the complete grouped key to `splitPackage`.

- [ ] **Step 3: Create the pure identity module**

Create `server/loader/versions/yarn-identity.ts`:

```ts
import type { Brand } from '../../../common/types.ts'

export type YarnText =
  | { missing: true }
  | { missing: false; content: string }

export type YarnRequestedName = Brand<string, 'YarnRequestedName'>
export type YarnResolvedName = Brand<string, 'YarnResolvedName'>

export type YarnIdentityInput =
  | { format: 'berry'; key: string; locator: YarnText }
  | { format: 'classic'; key: string }

export type YarnIdentityResult =
  | { invalid: true }
  | {
      invalid: false
      name: YarnResolvedName
      requested: YarnRequestedName[]
    }

type Coordinate = {
  ident: string
  reference: string
}

function separator(input: string): number {
  return input.indexOf('@', input.startsWith('@') ? 1 : 0)
}

function isIdent(input: string): boolean {
  return /^(@[^@/\s,"]+\/)?[^@/\s,"]+$/.test(input)
}

function parseCoordinate(input: string): Coordinate | undefined {
  let at = separator(input)
  if (at === -1) return undefined

  let ident = input.slice(0, at)
  let reference = input.slice(at + 1)
  if (reference === '' || !isIdent(ident)) return undefined

  return { ident, reference }
}

function unquote(input: string): string {
  if (input.startsWith('"') && input.endsWith('"')) {
    return input.slice(1, -1)
  }
  return input
}

function getTarget(coordinate: Coordinate): string | undefined {
  if (!coordinate.reference.startsWith('npm:')) return coordinate.ident

  let inner = coordinate.reference.slice(4)
  if (separator(inner) === -1) return coordinate.ident

  return parseCoordinate(inner)?.ident
}

export function resolveYarnIdentity(
  input: YarnIdentityInput
): YarnIdentityResult {
  let requested = new Set<string>()
  let targets = new Set<string>()

  for (let member of input.key.split(', ')) {
    let coordinate = parseCoordinate(unquote(member))
    if (!coordinate) return { invalid: true }

    let target = getTarget(coordinate)
    if (!target) return { invalid: true }

    requested.add(coordinate.ident)
    targets.add(target)
  }

  let names = [...requested] as YarnRequestedName[]

  if (input.format === 'berry' && !input.locator.missing) {
    let locator = parseCoordinate(input.locator.content)
    if (locator) {
      return {
        invalid: false,
        name: locator.ident as YarnResolvedName,
        requested: names
      }
    }
  }

  let [target] = targets
  if (target === undefined || targets.size > 1) return { invalid: true }

  return {
    invalid: false,
    name: target as YarnResolvedName,
    requested: names
  }
}
```

Parsing notes the implementer must preserve:

- `separator` returns the first `@` after an optional leading scope marker, so nested `@` characters in git, patch, or future protocol references never affect the outer ident.
- Malformed quoting needs no dedicated detection: an unstripped `"` fails `isIdent`, which forbids whitespace, quotes, commas, `@`, and extra `/`.
- Unknown protocols are accepted when the outer coordinate is structurally valid; only `npm:` references get inner alias-target extraction.
- Requested names are deduplicated here, once.
- The module never logs and exposes no failure-reason taxonomy.

- [ ] **Step 4: Rewrite the Yarn loader**

Replace the complete content of `server/loader/versions/yarn.ts`:

```ts
import { basename } from 'node:path'
import { parse } from 'yaml'

import { type Dependency, dependencyType } from '../../../common/types.ts'
import { warn } from '../../cli/print.ts'
import type { VersionsLoader } from './common.ts'
import { getDirectDependencies, separateFiles } from './common.ts'
import { resolveYarnIdentity, type YarnText } from './yarn-identity.ts'

type YarnEntry = {
  format: 'berry' | 'classic'
  key: string
  resolution: YarnText
  version: string
}

function text(value: unknown): YarnText {
  return typeof value === 'string'
    ? { missing: false, content: value }
    : { missing: true }
}

function isYarnBerry(content: string): boolean {
  return content.includes('__metadata:') && content.includes('version:')
}

function parseYarn1Lock(content: string): YarnEntry[] {
  let entries: Record<string, { resolution: YarnText; version: string }> = {}
  let current = ''

  for (let line of content.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue

    if (line.match(/^[^#\s].*:$/) && !line.startsWith(' ')) {
      current = line.slice(0, -1)
      entries[current] = { resolution: { missing: true }, version: '' }
    } else if (line.match(/^\s+version\s/) && current) {
      let match = line.match(/^\s+version\s+"([^"]+)"/)
      let entry = entries[current]
      if (match?.[1] && entry) entry.version = match[1].trim()
    } else if (line.match(/^\s+resolved\s/) && current) {
      let match = line.match(/^\s+resolved\s+"([^"]+)"/)
      let entry = entries[current]
      if (match?.[1] && entry) {
        entry.resolution = { missing: false, content: match[1].trim() }
      }
    }
  }

  let result: YarnEntry[] = []
  for (let [key, entry] of Object.entries(entries)) {
    if (!entry.version) continue
    result.push({
      format: 'classic',
      key,
      resolution: entry.resolution,
      version: entry.version
    })
  }
  return result
}

function parseYarnBerryLock(content: string): YarnEntry[] {
  let parsed = parse(content) as Record<string, unknown>
  let result: YarnEntry[] = []

  for (let key in parsed) {
    if (key === '__metadata' || key.includes('@workspace:')) continue

    let value = parsed[key]
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      typeof value.version !== 'string'
    ) {
      continue
    }

    result.push({
      format: 'berry',
      key,
      resolution: text('resolution' in value ? value.resolution : undefined),
      version: value.version
    })
  }
  return result
}

export const yarn = {
  findFiles(changed) {
    return changed.filter(file => {
      let name = basename(file)
      return name === 'package.json' || name === 'yarn.lock'
    })
  },
  load(files) {
    let dependencies: Dependency[] = []
    let { lockFiles, packageJsonFiles } = separateFiles(files, 'yarn.lock')
    let direct = getDirectDependencies(packageJsonFiles)

    for (let file of lockFiles) {
      for (
        let entry of isYarnBerry(file.content)
          ? parseYarnBerryLock(file.content)
          : parseYarn1Lock(file.content)
      ) {
        let identity = resolveYarnIdentity(
          entry.format === 'berry'
            ? { format: 'berry', key: entry.key, locator: entry.resolution }
            : { format: 'classic', key: entry.key }
        )

        if (identity.invalid) {
          warn(
            'Skipped unparseable Yarn lock entry',
            `${file.path}: ${entry.key}`
          )
          continue
        }

        dependencies.push(
          dependencyType({
            direct: identity.requested.some(name => direct.has(name)),
            from: 'yarn',
            name: identity.name,
            source: file.path,
            type: 'npm',
            version:
              !entry.resolution.missing &&
              (entry.resolution.content.includes('github.com') ||
                entry.resolution.content.includes('git+'))
                ? entry.resolution.content
                : entry.version
          })
        )
      }
    }

    return dependencies
  }
} satisfies VersionsLoader
```

The `splitPackage` import is gone. Format parsing stays free of identity selection: both parsers return raw keys and let `resolveYarnIdentity` choose names. The classic `resolved` URL is stored as `resolution` only for the git effective-version check and is never used for identity.

- [ ] **Step 5: Run the new tests and verify they pass**

Run:

```sh
pnpm bnt server/test/yarn.test.ts
```

Expected: PASS for all eight tests. These tests do not assert cross-entry coalescing; a Yarn 1 alias and its target serialized as separate entries still emit two dependencies until Task 2.

- [ ] **Step 6: Run required repository verification**

Run in order:

```sh
./scripts/format.sh
pnpm test:types
pnpm test
```

Expected: all commands exit 0, including the unchanged `server/test/yarn1.test.ts` and `server/test/yarn-berry.test.ts` end-to-end suites.

- [ ] **Step 7: Commit structural parsing**

```sh
git add server/loader/versions/yarn-identity.ts server/loader/versions/yarn.ts server/test/yarn.test.ts
git commit -m "Fix Yarn lockfile identity parsing"
```

## Task 2: Per-Lockfile Aggregation

**Files:**

- Modify: `server/loader/versions/yarn.ts`
- Modify: `server/test/yarn.test.ts`

**Interfaces:**

- Consumes: `YarnIdentityResult` values, the direct-dependency set, and the source lockfile from Task 1.
- Produces: one `Dependency` per `(resolved name, effective version)` inside each lockfile, with requested names unioned for directness.
- Preserves: lockfile boundaries, distinct effective versions, insertion order, and all public output fields.

- [ ] **Step 1: Write failing aggregation tests**

Append to `server/test/yarn.test.ts`:

```ts
test('coalesces separate Yarn 1 alias and target entries', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { 'my-alias': 'npm:lodash@4.17.21' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          'lodash@4.17.21:',
          '  version "4.17.21"',
          'my-alias@npm:lodash@4.17.21:',
          '  version "4.17.21"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'lodash',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '4.17.21'
      }
    ]
  )
})

test('keeps different effective versions separate', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { alias: 'npm:zeta@1.0.0' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          'zeta@1.0.0:',
          '  version "1.0.0"',
          'alpha@1.0.0:',
          '  version "1.0.0"',
          'alias@npm:zeta@1.0.0:',
          '  version "1.0.0"',
          'zeta@2.0.0:',
          '  version "2.0.0"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'zeta',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      },
      {
        direct: false,
        from: 'yarn',
        name: 'alpha',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      },
      {
        direct: false,
        from: 'yarn',
        name: 'zeta',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '2.0.0'
      }
    ]
  )
})

test('coalesces equal identities with different locators', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '"pkg@npm:^1.0.0":',
          '  version: 1.0.0',
          '  resolution: "pkg@npm:1.0.0"',
          '"pkg@patch:pkg@npm%3A1.0.0#hash":',
          '  version: 1.0.0',
          '  resolution: "pkg@patch:pkg@npm%3A1.0.0#hash"'
        ].join('\n')
      )
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'pkg',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      }
    ]
  )
})

test('does not aggregate across lockfiles', () => {
  let lock = ['pkg@1.0.0:', '  version "1.0.0"'].join('\n')
  assert.deepEqual(
    yarn.load([
      loadedFile('/first/yarn.lock', lock),
      loadedFile('/second/yarn.lock', lock)
    ]),
    [
      {
        direct: false,
        from: 'yarn',
        name: 'pkg',
        source: '/first/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      },
      {
        direct: false,
        from: 'yarn',
        name: 'pkg',
        source: '/second/yarn.lock',
        type: 'npm',
        version: '1.0.0'
      }
    ]
  )
})
```

- [ ] **Step 2: Run the aggregation test and verify it fails**

Run:

```sh
pnpm bnt server/test/yarn.test.ts -t 'coalesces separate Yarn 1 alias and target entries'
```

Expected: FAIL because Task 1 still emits one dependency per valid raw entry.

- [ ] **Step 3: Add local aggregation to the loader**

In `server/loader/versions/yarn.ts`, extend the identity-module import with the exported name types:

```ts
import {
  resolveYarnIdentity,
  type YarnRequestedName,
  type YarnResolvedName,
  type YarnText
} from './yarn-identity.ts'
```

Add after the `YarnEntry` type:

```ts
type YarnResolution = {
  name: YarnResolvedName
  requested: YarnRequestedName[]
  version: string
}

function aggregate(entries: YarnResolution[]): YarnResolution[] {
  let groups = new Map<string, YarnResolution>()

  for (let entry of entries) {
    let key = JSON.stringify([entry.name, entry.version])
    let group = groups.get(key)
    if (group) {
      group.requested = [...new Set([...group.requested, ...entry.requested])]
    } else {
      groups.set(key, { ...entry })
    }
  }

  return [...groups.values()]
}
```

Keep the type and function local to `yarn.ts`. The `Map` key is a plain serialized string; do not brand it and do not include the constant `'npm'` type. Insertion order gives first-occurrence output naturally.

- [ ] **Step 4: Aggregate inside each lockfile before Dependency construction**

Replace the `load` function body with:

```ts
load(files) {
  let dependencies: Dependency[] = []
  let { lockFiles, packageJsonFiles } = separateFiles(files, 'yarn.lock')
  let direct = getDirectDependencies(packageJsonFiles)

  for (let file of lockFiles) {
    let resolutions: YarnResolution[] = []

    for (
      let entry of isYarnBerry(file.content)
        ? parseYarnBerryLock(file.content)
        : parseYarn1Lock(file.content)
    ) {
      let identity = resolveYarnIdentity(
        entry.format === 'berry'
          ? { format: 'berry', key: entry.key, locator: entry.resolution }
          : { format: 'classic', key: entry.key }
      )

      if (identity.invalid) {
        warn(
          'Skipped unparseable Yarn lock entry',
          `${file.path}: ${entry.key}`
        )
        continue
      }

      resolutions.push({
        name: identity.name,
        requested: identity.requested,
        version:
          !entry.resolution.missing &&
          (entry.resolution.content.includes('github.com') ||
            entry.resolution.content.includes('git+'))
            ? entry.resolution.content
            : entry.version
      })
    }

    for (let entry of aggregate(resolutions)) {
      dependencies.push(
        dependencyType({
          direct: entry.requested.some(name => direct.has(name)),
          from: 'yarn',
          name: entry.name,
          source: file.path,
          type: 'npm',
          version: entry.version
        })
      )
    }
  }

  return dependencies
}
```

`resolutions` is created per lockfile; do not lift it or the `aggregate` call outside the `lockFiles` loop.

- [ ] **Step 5: Run all new tests**

Run:

```sh
pnpm bnt server/test/yarn.test.ts
```

Expected: PASS for all twelve tests.

- [ ] **Step 6: Run required repository verification**

Run in order:

```sh
./scripts/format.sh
pnpm test:types
pnpm test
```

Expected: all commands exit 0.

- [ ] **Step 7: Review the final diff**

Run:

```sh
git diff --check
git diff HEAD~1 -- server/loader/versions/yarn-identity.ts server/loader/versions/yarn.ts server/test/yarn.test.ts
```

Confirm:

- `splitPackage`, `common.ts`, `eslint.config.ts`, and dependency declarations are unchanged.
- No direct test of `resolveYarnIdentity` exists; every test calls `yarn.load()`.
- No warning originates in the pure identity module.
- Aggregation is scoped inside one lockfile.
- No `as any`, no default export, no comments in new code.

- [ ] **Step 8: Commit aggregation**

```sh
git add server/loader/versions/yarn.ts server/test/yarn.test.ts
git commit -m "Coalesce Yarn public dependency identities"
```

## Acceptance Criteria

- Grouped Yarn Berry and Yarn 1 keys no longer pass through `splitPackage`, and `yarn.ts` no longer imports it.
- The reported Berry fixture emits exactly one direct `caniuse-lite@1.0.30001750` dependency.
- `Dependency.name` always contains the canonical resolved package name used by downstream npm loading.
- Directness considers every requested name in the aggregate.
- A parseable Berry locator wins even when descriptor targets disagree; a missing or unparseable locator falls back only to one agreed target.
- Yarn 1 identity comes from descriptor syntax, never from `resolved` URLs.
- Unknown structurally valid protocols keep their requested ident as target.
- One malformed grouped member or disagreeing targets exclude the whole entry with one warning containing source path and raw key; other entries keep loading.
- Equal `(resolved name, effective version)` identities within one lockfile emit once with requested names unioned; different effective versions and different lockfiles stay separate.
- Git effective-version behavior, pnpm, npm, `Dependency`, `Change`, `calculateVersionDiff`, and lint configuration keep their current contracts.
- All new coverage is deterministic and offline, and only `server/test/yarn.test.ts` is added.
- `./scripts/format.sh`, `pnpm test:types`, and `pnpm test` pass in that order.

## Risks

- **Strict ident validation could reject valid future syntax.** Only the outer coordinate structure and ident shape are validated; protocols are not whitelisted, and reference content is unrestricted.
- **Exclusion hides a dependency.** Exclusion is local and never silent; the warning carries source path and raw key for diagnosis.
- **Aggregation changes cardinality.** It is isolated in the second commit and covered by directness-union, different-version, different-locator, and lockfile-boundary tests before the change is accepted.
- **Cross-lockfile duplicates remain.** `calculateVersionDiff` ignores source paths, so equal identities from different lockfiles can still produce duplicate downstream change IDs. That is an existing repository-wide behavior, recorded here and intentionally not changed by Issue #55.

## Scope Boundaries

This plan does not: expose requested aliases or raw locators publicly; change npm or pnpm identity, diff detection, tarball URL construction, or git fetching; aggregate across source lockfiles; add dependencies; or change lint configuration.
