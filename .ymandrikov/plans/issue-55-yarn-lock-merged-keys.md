# Issue #55: yarn.lock merged-key parsing bug

**Issue:** https://github.com/ai/multiocular/issues/55
**Status:** Analysis complete, fix not yet implemented
**Date:** 2026-07-14

## Summary

Yarn merges lockfile descriptors that resolve to the same version into a single
comma-separated key. `splitPackage()` cannot handle these merged keys and
produces a garbage package name, which flows into the npm tarball URL and
crashes the loader with a 404.

Reported against Yarn Berry (v4), but **Yarn 1 lockfiles are affected by the
same bug** — the issue title undersells the scope.

## Root cause

`splitPackage` in `server/loader/versions/common.ts:36`:

```ts
export function splitPackage(pkg: string): { name; version } {
  if (pkg.startsWith('"') && pkg.endsWith('"')) {
    pkg = pkg.slice(1, -1)
  }
  pkg = pkg.replace('@npm:', '@')

  // Looking from the end to support scoped packaged like @types/node
  let lastAtIndex = pkg.lastIndexOf('@')
  ...
}
```

Two defects:

1. **Merged keys not handled.** For a merged Berry key like
   `caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746`,
   `lastIndexOf('@')` runs over the whole comma-separated string:

   ```
   splitPackage('caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746')
   → { name: 'caniuse-lite@^1.0.30001702, caniuse-lite', version: 'npm:^1.0.30001746' }
   ```

   The broken name is then used to build the registry URL in
   `server/loader/npm.js` / `diffs/npm.js`, producing
   `https://registry.npmjs.org/caniuse-lite@^1.0.30001702, caniuse-lite/-/...`
   → 404 → `Error: Failed to download tarball`.

2. **`replace('@npm:', '@')` replaces only the first occurrence** (string
   argument to `String#replace`). Currently masked, but wrong on any
   multi-descriptor key.

## Call sites affected

| Parser | Location | Affected |
|---|---|---|
| `parseYarnBerryLock` | `server/loader/versions/yarn.ts:87` | Yes — merged keys like `"a@npm:^1, a@npm:^2":` |
| `parseYarn1Lock` | `server/loader/versions/yarn.ts:56` | Yes — same merged-key syntax: `a@^1, a@^2:` |

Both reproduce locally:

```
splitPackage('caniuse-lite@^1.0.30001702, caniuse-lite@^1.0.30001746')
→ { name: 'caniuse-lite@^1.0.30001702, caniuse-lite', version: '^1.0.30001746' }
```

Note: only `name` from `splitPackage` is consumed by the yarn loaders — the
version always comes from the entry body (`version:` field), so the garbage
`version` return value is harmless here.

## Why existing tests miss it

`server/test/yarn-berry.test.ts` and `server/test/yarn1.test.ts` are
integration tests: they run real `yarn add` of a single package (`nanoid`)
against the live registry.

- A single direct dependency never produces a merged key, so the case is
  structurally unreachable in the current fixtures.
- Live-registry tests are slow and rate-limited (the issue reporter hit rate
  limits trying to add coverage).

## Proposed fix

### 1. Berry parser: prefer `resolution` field for the name

Each Berry entry carries a canonical single locator:

```yaml
"caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746":
  version: 1.0.30001750
  resolution: "caniuse-lite@npm:1.0.30001750"
```

`resolution` is never comma-merged and holds the real package name (correct
even for npm aliases). In `parseYarnBerryLock`, parse the name from
`resolution` when present; fall back to the key otherwise.

### 2. `splitPackage`: handle merged keys defensively

Split on `,` and take the first descriptor before extracting the name:

```ts
pkg = pkg.split(',')[0].trim()
```

This fixes `parseYarn1Lock` (which has no `resolution`-equivalent shortcut —
Yarn 1 `resolved` is a tarball URL) and acts as a fallback for Berry.
Also change `replace('@npm:', '@')` to `replaceAll` or apply it after the
comma split.

### 3. Rejected alternative: one entry per merged descriptor

The reporter suggested emitting each comma-separated descriptor as a separate
dependency entry. Rejected:

- Merged descriptors share the same package name (except the rare npm-alias
  case), so splitting yields exact `name`+`version` duplicates.
- `calculateVersionDiff` (`server/loader/versions.ts`) has no dedup by id —
  duplicates would produce duplicate `Change` entries with identical ids in
  the UI.

### Edge case: npm aliases

Berry can merge descriptors with different idents when an alias resolves to
the same locator, e.g. `"lodash@npm:^4.0.0, my-alias@npm:lodash@^4.0.0"`.
Parsing the name from `resolution` (fix 1) handles this correctly
(`resolution: "lodash@npm:4.17.21"` → `lodash`). Key-splitting alone would
pick whichever descriptor sorts first. Another reason to prefer fix 1 for
Berry.

## Test plan

1. **Unit tests on the parsers with string fixtures** (no registry, no yarn
   binary). `parseYarnBerryLock` / `parseYarn1Lock` are module-private —
   either export them or drive through `yarn.load()` with in-memory
   `LoadedFile` objects. Cases:
   - Berry merged key (the issue's `caniuse-lite` example) → single entry,
     `name: 'caniuse-lite'`, `version: '1.0.30001750'`.
   - Berry merged key with scoped package
     (`"@babel/core@npm:^7.0.0, @babel/core@npm:^7.20.0":`).
   - Berry entry without `resolution` field → falls back to key parsing.
   - Berry npm-alias merged key → name taken from `resolution`.
   - Yarn 1 merged key (`caniuse-lite@^1.0.30001702, caniuse-lite@^1.0.30001746:`).
   - Yarn 1 merged key with scoped package.
   - Regression: simple unmerged keys for both formats still parse.
2. **`splitPackage` unit tests** in whatever test file covers `common.ts`
   (add one if none): merged input, scoped merged input, `@npm:` on both
   descriptors.
3. **Optional integration test:** two direct deps sharing a transitive range
   spread (forces a merged key) — only if live-registry cost is acceptable;
   unit fixtures above already cover the parse path.

## Fix checklist

- [ ] `parseYarnBerryLock`: derive name from `resolution` with key fallback
- [ ] `splitPackage`: comma-split defensively + fix `@npm:` first-occurrence replace
- [ ] Unit tests per test plan
- [ ] Verify against reporter's `caniuse-lite` fixture from the issue
- [ ] Reply on #55
