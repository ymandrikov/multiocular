# Issue #55 Yarn Grouped Descriptors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse Yarn lockfile entries containing multiple descriptors as one correctly named resolved dependency, fixing GitHub issue #55 for Yarn Berry and the equivalent Yarn 1 case.

**Architecture:** Keep `splitPackage` responsible for parsing one package descriptor. Add a Yarn-specific normalization function in the Yarn loader that selects the first descriptor from a grouped lockfile key before delegating to `splitPackage`. Exercise the public `yarn.load()` interface with in-memory branded `LoadedFile` fixtures so regression tests do not invoke Yarn or access package registries.

**Tech Stack:** TypeScript 6, Node.js test runner, better-node-test, `yaml`, pnpm

## Global Constraints

- Prefer short one-word variable names. Avoid abbreviations: use `current` instead of `cur`.
- Do not add any comments to generated code by default.
- Import only specific functions. Don’t import everything.
- Don’t use `export default`.
- Always use `.ts` in TS files imports.
- Use discriminant union in types: `{ missing: true } | { missing: false, content: string }` instead of `{ missing: boolean, content?: string }`.
- Do not create variable which you will use in single place.
- Avoid adding dependencies.
- Always use TypeScript with branded types.
- Never change `eslint.config.ts`. Always change code to fix found issues.
- Never use `as any`.
- Always merge type and regular import.
- Always run `./scripts/format.sh` and `pnpm test`.
- Before running `pnpm test` always run `./scripts/format.sh` and `pnpm test:types` first.
- Run a specific test with `pnpm bnt path/to/test.test.ts -t 'test name'`.

---

## Issue Status

- Issue: [ai/multiocular#55](https://github.com/ai/multiocular/issues/55)
- Title: `yarn.lock (berry) files are not properly parsed when multiple dependencies were resolved to a single version`
- Reporter: `michael42`
- Opened: 2025-10-16
- State checked: open, with no assignee, labels, comments, milestone, project, or timeline activity
- Reported release: 0.8.1
- Verified affected revisions: current upstream `main` at `555316c3e96bb6737fb73107aee148ec705f5aca` and release 0.8.3

No implementation change for this issue exists in the current repository history.

## Summary

Yarn groups multiple dependency descriptors into one lockfile key when they resolve to the same package locator. Multiocular currently sends the entire grouped key to a parser that accepts only one descriptor. The parser consequently combines part of the first descriptor with the name of the second descriptor, creating an invalid npm package name.

The malformed name causes two visible problems:

1. A genuinely direct dependency can be marked indirect because the malformed name does not match the dependency name in `package.json`.
2. When the dependency version changes, the malformed name reaches the npm tarball loader and produces a registry URL that returns 404.

The report uses Yarn Berry, but Yarn 1 uses the same grouped-key concept and passes its grouped keys through the same single-descriptor parser. The implementation should therefore cover both formats.

## Reproduction

The issue fixture is:

```yaml
__metadata:
  version: 8
  cacheKey: 10c0

"caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746":
  version: 1.0.30001750
  resolution: "caniuse-lite@npm:1.0.30001750"
  checksum: 10c0/aa77ebf264ca8dcfe913fadaa19f06bf839d65dec24498fdb9c45739ab0828b8275ca30c698f4ee86829d38264eaa461edf4577e407753da8205ab1d285e105d
  languageName: node
  linkType: hard
```

Passing this lockfile and a `package.json` that directly depends on `caniuse-lite` to the current `yarn.load()` returns:

```json
[
  {
    "direct": false,
    "from": "yarn",
    "name": "caniuse-lite@^1.0.30001702, caniuse-lite",
    "source": "yarn.lock",
    "type": "npm",
    "version": "1.0.30001750"
  }
]
```

Expected result:

```json
[
  {
    "direct": true,
    "from": "yarn",
    "name": "caniuse-lite",
    "source": "yarn.lock",
    "type": "npm",
    "version": "1.0.30001750"
  }
]
```

## Root Cause

### 1. The YAML parser correctly preserves the grouped key

`parseYarnBerryLock` in `server/loader/versions/yarn.ts` parses the lockfile with `yaml.parse`. The resulting record has one entry whose key is:

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

This is expected Yarn behavior. Multiple descriptors map to one resolved package entry.

### 2. The Yarn loader treats the grouped key as one descriptor

The Berry loader currently calls:

```ts
let name = splitPackage(key).name
```

The Yarn 1 loader makes the equivalent call:

```ts
let { name } = splitPackage(entry)
```

Neither call separates the descriptors first.

### 3. `splitPackage` is designed for one descriptor

`splitPackage` in `server/loader/versions/common.ts` performs these operations:

```ts
pkg = pkg.replace('@npm:', '@')
let lastAtIndex = pkg.lastIndexOf('@')
```

For the issue key, the first `@npm:` is normalized, but `lastIndexOf('@')` searches across both descriptors. The result is:

```text
name: caniuse-lite@^1.0.30001702, caniuse-lite
version: npm:^1.0.30001746
```

The fact that `String.prototype.replace` changes only the first `@npm:` occurrence contributes to the exact malformed output, but it is not a separate defect that requires `replaceAll`. Once a Yarn key is reduced to one descriptor, the existing single replacement is sufficient for the issue case.

### 4. The bad name crosses component boundaries unchanged

The data path is:

```text
yarn.lock grouped key
  → parseYarnBerryLock or parseYarn1Lock
  → splitPackage receives multiple descriptors
  → Dependency.name is malformed
  → calculateVersionDiff creates Change.name from Dependency.name
  → npm.findRepository and npm.loadDiff call getNpmContent
  → buildTarballUrl interpolates the malformed name
  → registry request returns 404
```

For the reported example, `buildTarballUrl` produces a URL shaped like:

```text
https://registry.npmjs.org/caniuse-lite@^1.0.30001702, caniuse-lite/-/caniuse-lite@^1.0.30001702, caniuse-lite-1.0.30001750.tgz
```

### 5. Direct-dependency detection also fails

`getDirectDependencies` correctly reads `caniuse-lite` from `package.json`. The Yarn loader checks:

```ts
direct: directDeps.has(dep.name)
```

Because `dep.name` is malformed, the lookup returns `false` even when `caniuse-lite` is direct.

### 6. History explains the Berry regression

Commit `9797117` (`Fix scoped package support`) replaced Berry-specific name extraction with the shared `splitPackage` call. The prior Berry implementation took the substring before the first `@npm:`, which happened to return the correct package name for the reported grouped key. The shared helper improved scoped-package handling but introduced this Berry regression because it assumes one descriptor.

The Yarn 1 parser already used last-`@` extraction over the entire entry, so grouped Yarn 1 keys represent a pre-existing version of the same bug rather than a regression introduced by `9797117`.

## Why Existing Tests Miss the Bug

`server/test/yarn-berry.test.ts` and `server/test/yarn1.test.ts` create temporary projects, install one requested version, commit it, and install a second version. Those tests validate the full CLI path but normally generate lock entries containing only one descriptor.

No test passes a grouped lock key directly to the versions loader. Reaching the reported shape through package installation would also require carefully selected dependency graphs and live registry access, making the test slower and less deterministic. The reporter encountered registry rate limiting while trying to find such packages.

The missing coverage is best added at the `yarn.load()` boundary with literal lockfile fixtures. This boundary includes format detection, YAML or Yarn 1 parsing, grouped-key normalization, branded `Dependency` creation, and direct-dependency detection without invoking networked diff loading.

## Proposed Fixes

### Recommended: add Yarn-specific grouped-key normalization

Add a private helper to `server/loader/versions/yarn.ts`:

```ts
function splitYarnPackage(entry: string): {
  name: DependencyName
  version: DependencyVersion
} {
  return splitPackage(entry.split(',', 1)[0]!.trim())
}
```

Use it in both Yarn parsers:

```ts
let { name } = splitYarnPackage(entry)
```

```ts
let name = splitYarnPackage(key).name
```

This solution is preferred because:

- Grouped keys are a Yarn lockfile concern, so the normalization stays in the Yarn loader.
- Both Yarn Berry and Yarn 1 receive the fix through one private helper.
- `splitPackage` retains its current contract of parsing one descriptor for pnpm and other callers.
- The output remains one dependency for one resolved lock entry.
- The implementation does not add a dependency or expand the public API.
- Selecting the first descriptor matches the issue reporter's successful workaround while placing it at the correct format boundary.

### Alternative: make `splitPackage` accept grouped keys

Adding `pkg = pkg.split(',', 1)[0]!.trim()` to `splitPackage` would also fix both Yarn parsers. It is not recommended because `splitPackage` is shared with pnpm and its existing examples and return type describe one package coordinate. Making a generic helper silently understand Yarn's grouped-key serialization broadens its contract and risks changing non-Yarn version parsing unnecessarily.

### Alternative: parse Berry names from `resolution`

The issue fixture has a single `resolution` locator, so using that field appears attractive. It is not the minimal general fix:

- Yarn 1 still needs grouped-key normalization because its `resolved` value is a tarball URL.
- Yarn locators can use protocols such as `git`, `patch`, `portal`, `workspace`, or npm aliases and can contain additional `@` characters.
- `splitPackage` is not a general Yarn locator parser, so passing every `resolution` value to it would create a separate parsing problem.
- The descriptor key already contains the dependency ident needed by Multiocular.

The `resolution` field should remain responsible for the existing git-version handling, not become the name source as part of this focused fix.

### Rejected: emit one dependency per descriptor

The comma-separated descriptors share one resolved lock entry. Multiocular compares installed package name and version, not requested ranges. Emitting each descriptor would usually create identical `Dependency` values and can create duplicate `Change` records because `calculateVersionDiff` iterates every after-dependency without deduplicating change ids.

The correct result for the issue fixture is one `caniuse-lite@1.0.30001750` dependency.

## Acceptance Criteria

- The issue's Berry fixture produces exactly one dependency named `caniuse-lite` at version `1.0.30001750`.
- The dependency is marked direct when `package.json` contains `caniuse-lite`.
- A grouped Yarn 1 key produces the same normalized result.
- Grouped scoped-package keys produce one correctly scoped name in both formats.
- Existing single-descriptor Yarn Berry and Yarn 1 tests continue to pass.
- No duplicate dependency or change is created for the grouped descriptors.
- `splitPackage` remains unchanged and continues returning branded `DependencyName` and `DependencyVersion` values.
- No dependencies or public exports are added.
- `eslint.config.ts` is unchanged.
- Formatting, type checks, and the full test suite pass in the required order.

## File Map

| File | Change | Responsibility |
| --- | --- | --- |
| `server/test/yarn-versions.test.ts` | Create | Deterministic loader-level regression fixtures for grouped Berry and Yarn 1 keys |
| `server/loader/versions/yarn.ts` | Modify | Normalize a grouped Yarn key to its first descriptor before calling `splitPackage` |

Files intentionally not changed:

- `server/loader/versions/common.ts`: its single-descriptor contract remains intact.
- `server/loader/npm.ts`: it receives a corrected dependency name; the tarball URL builder is not the source of the bug.
- `server/loader/versions.ts`: duplicate prevention is unnecessary when each resolved Yarn entry emits once.
- `eslint.config.ts`: explicitly prohibited by repository instructions.

## Test Plan

### Deterministic regression coverage

Create `server/test/yarn-versions.test.ts` and call the exported `yarn.load()` loader with `loadedFile()` so file paths and contents use the repository's branded types.

Cover four grouped-key cases:

1. The exact unscoped Yarn Berry scenario from issue #55.
2. A scoped Yarn Berry package with two descriptors.
3. The Yarn 1 equivalent of the issue scenario.
4. A quoted scoped Yarn 1 grouped key.

Each assertion must verify the entire `Dependency` value, including `direct`, `from`, `name`, `source`, `type`, and `version`, and must verify that only one array item is returned.

### Existing integration coverage

Run the existing Berry and Yarn 1 integration files. They cover single descriptors, scoped packages, full CLI loading, registry downloads, and diff generation.

### Required repository validation

Run formatting, type checking, and the complete test suite in the order mandated by `AGENTS.md`:

```bash
./scripts/format.sh
pnpm test:types
pnpm test
```

## Implementation Tasks

### Task 1: Normalize grouped Yarn descriptors

**Files:**

- Create: `server/test/yarn-versions.test.ts`
- Modify: `server/loader/versions/yarn.ts`

**Interfaces:**

- Consumes: `loadedFile(path: string, content: Buffer | string): LoadedFile` from `common/types.ts`
- Consumes: `yarn.load(files: LoadedFile[]): Dependency[]` from `server/loader/versions/yarn.ts`
- Consumes: `splitPackage(pkg: string): { name: DependencyName; version: DependencyVersion }` from `server/loader/versions/common.ts`
- Produces: private `splitYarnPackage(entry: string): { name: DependencyName; version: DependencyVersion }`
- Produces no new public export

- [ ] **Step 1: Create the failing loader-level regression tests**

Create `server/test/yarn-versions.test.ts` with this complete content:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Dependency, loadedFile } from '../../common/types.ts'
import { yarn } from '../loader/versions/yarn.ts'

function load(content: string, name: string): Dependency[] {
  return yarn.load([
    loadedFile('yarn.lock', content),
    loadedFile(
      'package.json',
      JSON.stringify({ dependencies: { [name]: '*' } })
    )
  ])
}

test('loads merged Yarn Berry descriptors once', () => {
  assert.deepEqual(
    load(
      `__metadata:
  version: 8
  cacheKey: 10c0

"caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746":
  version: 1.0.30001750
  resolution: "caniuse-lite@npm:1.0.30001750"
  checksum: 10c0/aa77
  languageName: node
  linkType: hard
`,
      'caniuse-lite'
    ),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'caniuse-lite',
        source: 'yarn.lock',
        type: 'npm',
        version: '1.0.30001750'
      }
    ]
  )
})

test('loads merged scoped Yarn Berry descriptors once', () => {
  assert.deepEqual(
    load(
      `__metadata:
  version: 8
  cacheKey: 10c0

"@babel/core@npm:^7.0.0, @babel/core@npm:^7.20.0":
  version: 7.25.2
  resolution: "@babel/core@npm:7.25.2"
  checksum: 10c0/aa77
  languageName: node
  linkType: hard
`,
      '@babel/core'
    ),
    [
      {
        direct: true,
        from: 'yarn',
        name: '@babel/core',
        source: 'yarn.lock',
        type: 'npm',
        version: '7.25.2'
      }
    ]
  )
})

test('loads merged Yarn 1 descriptors once', () => {
  assert.deepEqual(
    load(
      `caniuse-lite@^1.0.30001702, caniuse-lite@^1.0.30001746:
  version "1.0.30001750"
  resolved "https://registry.yarnpkg.com/caniuse-lite/-/caniuse-lite-1.0.30001750.tgz"
`,
      'caniuse-lite'
    ),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'caniuse-lite',
        source: 'yarn.lock',
        type: 'npm',
        version: '1.0.30001750'
      }
    ]
  )
})

test('loads merged scoped Yarn 1 descriptors once', () => {
  assert.deepEqual(
    load(
      `"@babel/core@^7.0.0", "@babel/core@^7.20.0":
  version "7.25.2"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.25.2.tgz"
`,
      '@babel/core'
    ),
    [
      {
        direct: true,
        from: 'yarn',
        name: '@babel/core',
        source: 'yarn.lock',
        type: 'npm',
        version: '7.25.2'
      }
    ]
  )
})
```

- [ ] **Step 2: Run the issue regression test and verify the current failure**

Run:

```bash
pnpm bnt server/test/yarn-versions.test.ts -t 'loads merged Yarn Berry descriptors once'
```

Expected: FAIL. The actual dependency has `direct: false` and name `caniuse-lite@^1.0.30001702, caniuse-lite` instead of the expected direct `caniuse-lite` dependency.

- [ ] **Step 3: Add the private grouped-key normalization helper**

In `server/loader/versions/yarn.ts`, expand the existing `common/types.ts` import to include the branded name and version types:

```ts
import {
  type Dependency,
  type DependencyName,
  dependencyType,
  type DependencyVersion
} from '../../../common/types.ts'
```

Add this function after `isYarnBerry`:

```ts
function splitYarnPackage(entry: string): {
  name: DependencyName
  version: DependencyVersion
} {
  return splitPackage(entry.split(',', 1)[0]!.trim())
}
```

Change the Yarn 1 call site to:

```ts
let { name } = splitYarnPackage(entry)
```

Change the Yarn Berry call site to:

```ts
let name = splitYarnPackage(key).name
```

Do not modify `splitPackage`, `resolution` handling, npm downloading, or change calculation.

- [ ] **Step 4: Run the issue regression test and verify it passes**

Run:

```bash
pnpm bnt server/test/yarn-versions.test.ts -t 'loads merged Yarn Berry descriptors once'
```

Expected: PASS with one direct `caniuse-lite@1.0.30001750` dependency.

- [ ] **Step 5: Run all new grouped-key tests**

Run:

```bash
pnpm bnt server/test/yarn-versions.test.ts
```

Expected: four tests pass with no skipped or failed tests.

- [ ] **Step 6: Run the existing Yarn integration tests**

Run:

```bash
pnpm bnt server/test/yarn-berry.test.ts
pnpm bnt server/test/yarn1.test.ts
```

Expected: both commands exit successfully and all existing Yarn tests pass.

- [ ] **Step 7: Run mandatory formatting and full verification**

Run in this exact order:

```bash
./scripts/format.sh
pnpm test:types
pnpm test
```

Expected: every command exits with status 0. `pnpm test` completes all configured test scripts without failures.

- [ ] **Step 8: Review the final diff for scope and whitespace errors**

Run:

```bash
git diff --check
git diff -- server/loader/versions/yarn.ts server/test/yarn-versions.test.ts
```

Expected: `git diff --check` prints nothing. The code diff contains only the private helper, two updated call sites, branded type imports, and the new regression tests.

- [ ] **Step 9: Commit the focused fix**

```bash
git add server/loader/versions/yarn.ts server/test/yarn-versions.test.ts
git commit -m "Fix grouped Yarn lockfile keys"
```

Expected: one commit containing only the parser fix and deterministic regression coverage.

## Post-Implementation Verification Against the Report

After the full suite passes, load the reporter's exact fixture through `yarn.load()` or retain it verbatim in the first regression test. Confirm these observable properties before reporting the issue fixed:

```text
dependency count: 1
name: caniuse-lite
version: 1.0.30001750
direct: true when package.json declares caniuse-lite
generated registry package name: caniuse-lite
```

Do not close or comment on GitHub issue #55 without separate authorization. A suitable implementation summary for a future pull request or issue comment is:

```text
Normalize grouped Yarn lockfile keys before package descriptor parsing. The fix covers Yarn Berry and Yarn 1, preserves one dependency per resolved lock entry, and adds deterministic loader-level fixtures that do not access package registries.
```
