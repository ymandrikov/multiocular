# Issue #55: Yarn merged descriptors — combined analysis and long-term fix design

**Issue:** https://github.com/ai/multiocular/issues/55
**Status:** Design; supersedes `issue-55-yarn-grouped-descriptors-analysis.md` and `issue-55-yarn-lock-merged-keys.md`
**Date:** 2026-07-14

This document merges the two prior analyses and resolves their disagreement in
favor of a long-term design: the Yarn loader gets its own structural
descriptor/locator parser, and `splitPackage` returns to being a single-coordinate
helper used only by pnpm. A minimal short-term fix is kept as stage 1 so the
reported bug ships independently of the larger change.

## Summary

Yarn (both Yarn 1 and Berry) merges multiple dependency descriptors that
resolve to the same package into one comma-separated lockfile key.
`splitPackage()` in `server/loader/versions/common.ts` parses one coordinate;
fed a merged key, it produces a garbage package name.

Two visible symptoms follow:

1. **Wrong `direct` flag.** `directDeps.has(dep.name)` (`server/loader/versions/yarn.ts:133`)
   never matches the malformed name, so a genuinely direct dependency is shown
   as indirect.
2. **404 on diff loading.** The malformed name flows into the npm tarball URL
   builder and produces a registry request like
   `https://registry.npmjs.org/caniuse-lite@^1.0.30001702, caniuse-lite/-/...`,
   which fails with `Error: Failed to download tarball`.

The issue is reported against Yarn Berry, but Yarn 1 uses the same merged-key
serialization through the same parser, so both formats are in scope.

## Root cause

`splitPackage` (`server/loader/versions/common.ts:36`) extracts the name with
`lastIndexOf('@')` over the whole input. For the merged key

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

it returns:

```text
name:    caniuse-lite@^1.0.30001702, caniuse-lite
version: npm:^1.0.30001746
```

Both Yarn call sites pass merged keys unsplit:

| Parser | Location |
|---|---|
| `parseYarn1Lock` | `server/loader/versions/yarn.ts:56` |
| `parseYarnBerryLock` | `server/loader/versions/yarn.ts:87` |

Facts verified against the code that constrain the fix:

- Only `name` from `splitPackage` is consumed by the Yarn loaders; the version
  always comes from the entry body (`version:` field / `version "..."` line).
  The garbage `version` return value is harmless on the Yarn path.
- `pkg.replace('@npm:', '@')` replaces only the first occurrence, but a single
  descriptor contains at most one `@npm:`, so this is not a separate defect
  once descriptors are split. No `replaceAll` change is needed.
- The Berry case is a regression from commit `9797117` (`Fix scoped package
  support`), which replaced Berry-specific name extraction with the shared
  `splitPackage` call. The Yarn 1 case is a pre-existing instance of the same
  bug.

## Why existing tests miss it

`server/test/yarn-berry.test.ts` and `server/test/yarn1.test.ts` are
integration tests: they install a single package with the real Yarn binary
against the live registry. A single direct dependency never produces a merged
key, so the shape is structurally unreachable in current fixtures, and
live-registry tests are too slow and rate-limited to force it (the issue
reporter hit rate limits attempting exactly that).

The missing coverage belongs at the `yarn.load()` boundary with in-memory
`LoadedFile` string fixtures: deterministic, offline, and covering format
detection, parsing, branded `Dependency` construction, and direct-dependency
detection in one pass.

## The requirement both prior fixes missed: two names

The npm-alias case exposes that one `name` is being asked to serve two
consumers with different needs. Given `package.json`:

```json
{ "dependencies": { "my-alias": "npm:lodash@^4.0.0" } }
```

Berry produces:

```yaml
"lodash@npm:^4.0.0, my-alias@npm:lodash@^4.0.0":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
```

- **Direct detection** needs the *descriptor ident* as declared in
  `package.json` (`my-alias`).
- **Registry fetching and diff display** need the *resolution ident* — the
  real installed package (`lodash`), because that is whose tarball changed.

Neither prior proposal satisfies both:

- Taking the first descriptor from the key (prior doc A) yields whichever
  ident sorts first; if the alias sorts first, both consumers get the wrong
  name. (Today even an *unmerged* alias key is mis-parsed, so this is a
  pre-existing limitation, not a regression — but the long-term design should
  close it.)
- Taking the name from `resolution` naively (prior doc B) fixes the registry
  name but breaks direct detection for aliases, and — worse — regresses
  non-npm protocols: a git resolution like
  `nanoid@git@github.com:ai/nanoid.git#commit=abc` fed to `splitPackage`
  yields `nanoid@git`. `splitPackage` is not a locator parser, and doc B's
  fallback only triggers when `resolution` is *absent*, not when its protocol
  is non-npm.

The correct model: **direct detection consults every descriptor ident; the
dependency name comes from the resolution ident.**

## Long-term design

### Principle

Each lockfile format owns its own serialization quirks. Merged keys, quoting,
protocols, and aliases are Yarn concepts, so their parsing lives in
`server/loader/versions/yarn.ts`. `splitPackage` keeps its documented
single-coordinate contract (`nanoid@5.0.0`, `@types/node@22.0.0`) and remains
the pnpm helper. The end state removes the `splitPackage` import from
`yarn.ts` entirely.

### Structural parsing instead of `@`-counting

Yarn coordinates follow one grammar: `ident@reference`, where `ident` is a
possibly-scoped package name and `reference` is `protocol:selector` (protocol
optional in Yarn 1 descriptors). An ident cannot contain `@` except as the
leading scope marker, so the correct split point is the **first `@` after the
scope**, not the last `@` in the string:

```ts
function parseCoordinate(input: string): { ident: string; reference: string } {
  let at = input.indexOf('@', input.startsWith('@') ? 1 : 0)
  if (at === -1) return { ident: input, reference: '' }
  return { ident: input.slice(0, at), reference: input.slice(at + 1) }
}
```

This is the same strategy as Yarn's own `structUtils.parseDescriptor` /
`parseLocator`, and it is robust for every reference shape that breaks
`lastIndexOf('@')`: `npm:^1.0.0`, `npm:lodash@^4.0.0` (alias),
`git@github.com:...`, `patch:lodash@npm%3A4.17.21#...`, `portal:`,
`workspace:`.

On top of it, two thin format functions:

```ts
function parseMergedKey(key: string): string[] {
  return key.split(', ').map(stripQuotes)
}
```

- Berry joins descriptors with `", "`; npm semver ranges cannot contain a
  comma, so the split is unambiguous.
- Yarn 1 quotes each descriptor individually
  (`"@babel/core@^7.0.0", "@babel/core@^7.20.0":`), so quote-stripping happens
  per descriptor after the split, replacing the whole-string quote handling
  currently inside `splitPackage`.

### Name and direct-flag policy

For each resolved lock entry (Berry):

- `name` = ident of the `resolution` locator. This is the installed package —
  correct for registry URLs, diffs, and display, including aliases.
- `direct` = true when **any** descriptor ident from the merged key is in
  `directDeps`. This keeps alias-declared direct dependencies marked direct.
- Fallback when `resolution` is missing or unparsable: ident of the first
  descriptor. This keeps malformed-lockfile behavior no worse than today.
- Git handling unchanged: `resolved`/`resolution` containing `github.com` or
  `git+` still swaps the version for the resolved URL.

For Yarn 1:

- `name` = ident of the first descriptor (after quote-stripping). Yarn 1 has
  no structured resolution — `resolved` is a tarball URL.
- `direct` = any descriptor ident in `directDeps`.
- Alias support for Yarn 1 (extracting the real name from the `resolved`
  tarball URL path) is possible but optional; see stage 3.

One `Dependency` per resolved lock entry, as today. Emitting one entry per
descriptor stays rejected: descriptors share the installed package, and
`calculateVersionDiff` (`server/loader/versions.ts`) has no dedup by id, so
per-descriptor emission creates duplicate `Change` records.

### Data-model note

`Dependency.name` after this design means "installed package name". For an
aliased dependency the UI will show `lodash`, not `my-alias`. This is the
right default — the changed code is lodash's — but it is a visible decision.
If alias display becomes a requirement later, it needs a second field on
`Dependency` (e.g. `declaredAs`), not a different `name`; the registry path
must keep receiving the real name.

## Staged delivery

The long-term design should not block the bug fix. Three independent stages:

### Stage 1 — ship the #55 fix (small, now)

Yarn-local helper in `yarn.ts`, both parsers call it:

```ts
function splitYarnPackage(entry: string) {
  return splitPackage(entry.split(',', 1)[0]!.trim())
}
```

Fixes the reported case, scoped merged keys, Yarn 1 and Berry. Leaves aliases
exactly as broken as they are today (they mis-parse even unmerged). No shared
code touched.

### Stage 2 — structural parser (the long-term option)

Replace `splitYarnPackage` and both `splitPackage` call sites in `yarn.ts`
with `parseCoordinate` + `parseMergedKey` and the name/direct policy above.
Remove the `splitPackage` import from `yarn.ts`. Remove the now-dead
Yarn-quote handling from `splitPackage` only if pnpm fixtures confirm pnpm
never feeds quoted input — otherwise leave it.

Stage 2 fixes, beyond stage 1: Berry aliases (merged and unmerged), correct
`direct` for alias-declared deps, correct parsing of `patch:`/`portal:`
locators if they ever reach name extraction.

### Stage 3 — optional Yarn 1 alias support

Derive the real name from the `resolved` registry URL path for aliased Yarn 1
entries. Only worth doing on demand; Yarn 1 is legacy and aliases there are
rare.

## Testability

All regression coverage sits at the public `yarn.load()` boundary with
in-memory branded `LoadedFile` fixtures — no Yarn binary, no registry, no
private exports. Every assertion checks the complete `Dependency` value
(`direct`, `from`, `name`, `source`, `type`, `version`) and the array length.

Fixture matrix (stage 1 subset marked ✦):

| Case | Format | Expectation |
|---|---|---|
| ✦ Issue's `caniuse-lite` merged key | Berry | one entry, `name: caniuse-lite`, `direct: true` |
| ✦ Scoped merged key (`@babel/core`) | Berry | one entry, scoped name intact |
| ✦ Merged key, unquoted | Yarn 1 | one entry, correct name |
| ✦ Merged key, per-descriptor quotes, scoped | Yarn 1 | one entry, correct name |
| ✦ Unmerged single-descriptor key (regression guard) | both | unchanged behavior |
| Alias merged key, alias declared in `package.json` | Berry | `name: lodash`, `direct: true` (stage 2) |
| Alias merged key, alias descriptor sorts first | Berry | same as above — order-independent (stage 2) |
| Entry without `resolution` | Berry | falls back to first descriptor ident (stage 2) |
| Git dependency with `resolution` | Berry | name correct, version = resolved URL (stage 2 regression guard) |

`parseCoordinate` and `parseMergedKey` are pure functions and additionally get
direct unit tests with the protocol zoo (`npm:`, alias, `git@`, `patch:`,
`portal:`, scoped idents) — cheap to enumerate, impossible to reach through
`yarn.load()` fixtures alone.

Existing integration tests (`yarn-berry.test.ts`, `yarn1.test.ts`) stay as-is:
they cover the real-binary end-to-end path; the new suite covers parsing.

## Maintainability

- **Locality:** every Yarn serialization rule (merged keys, quoting,
  protocols, aliases) lives in one file next to the two parsers that need it.
  Deleting or upgrading Yarn support touches one module.
- **One parsing strategy:** `parseCoordinate` replaces three ad-hoc mechanisms
  (`lastIndexOf('@')`, `replace('@npm:')`, whole-string quote stripping) with
  one grammar-derived rule. Fewer interacting string hacks, fewer masked
  edge cases.
- **Shared helper stays honest:** `splitPackage`'s doc comment and examples
  remain true; pnpm's behavior cannot be perturbed by Yarn fixes.
- **No defensive redundancy:** the design deliberately avoids doc B's
  belt-and-suspenders shape (resolution preference *plus* defensive
  comma-split in the shared helper) — two mechanisms for one bug means
  neither is clearly load-bearing and both must be maintained.

## Acceptance criteria

Stage 1:

- Issue fixture yields exactly one dependency: `caniuse-lite`,
  `1.0.30001750`, `direct: true` when declared in `package.json`.
- Grouped scoped keys correct in both formats; single-descriptor keys
  unchanged; existing integration tests pass.
- `splitPackage`, `eslint.config.ts`, public API, and dependency set
  unchanged.

Stage 2 (additional):

- Alias merged keys yield the installed package name regardless of descriptor
  order, with `direct: true` when the alias is declared.
- Git/patch/portal resolutions never produce a name containing `@` past the
  scope marker.
- `yarn.ts` no longer imports `splitPackage`.
- Full fixture matrix above passes; format, type check, and full test suite
  pass in the required order (`./scripts/format.sh`, `pnpm test:types`,
  `pnpm test`).

## Rejected alternatives (consolidated)

- **Comma-split inside `splitPackage`:** works mechanically, but encodes Yarn
  serialization in a helper shared with pnpm and silently widens its
  documented contract. Superseded by stage 2's format-local parser.
- **Naive `resolution`-based naming via `splitPackage`:** regresses git
  dependencies (`nanoid@git@github.com:... → nanoid@git`) and still gets
  `direct` wrong for aliases. Correct only with a structural locator parser —
  which is stage 2.
- **One dependency per merged descriptor:** duplicate `Dependency` values and
  duplicate `Change` ids downstream; the resolved entry is the unit
  multiocular compares.
- **`replaceAll('@npm:')`:** no covered need once descriptors are split; a
  behavior change to shared code with zero fixtures demanding it.
