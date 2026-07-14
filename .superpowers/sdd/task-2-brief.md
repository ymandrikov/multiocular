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
