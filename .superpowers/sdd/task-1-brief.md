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

