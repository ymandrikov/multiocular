# Issue #55: Yarn descriptor/locator identity — merged staged plan

**Issue:** https://github.com/ai/multiocular/issues/55
**Status:** Design; supersedes `issue-55-yarn-descriptors-longterm.md` and
`issue-55-yarn-lockfile-identity-design.md`
**Date:** 2026-07-14

This document merges the staged engineering plan
(`issue-55-yarn-descriptors-longterm.md`) with the identity specification
(`issue-55-yarn-lockfile-identity-design.md`). The plan's skeleton — staged
delivery, code citations, fixture matrix, acceptance process — carries the
specification's semantics: the descriptor/locator domain model, agreed-target
fallback, descriptor-based Yarn 1 alias naming, and explicit failure
semantics. Three decisions the source documents disagreed on are resolved in
"Resolved decisions" below.

## Summary

Yarn (both Yarn 1 and Berry) merges multiple dependency descriptors that
resolve to the same package into one comma-separated lockfile key.
`splitPackage()` (`server/loader/versions/common.ts:36`) parses one
coordinate; fed a merged key, its last-`@` search
(`server/loader/versions/common.ts:47`) crosses the descriptor boundary and
produces a garbage package name.

Two visible symptoms follow:

1. **Wrong `direct` flag.** `directDeps.has(dep.name)`
   (`server/loader/versions/yarn.ts:133`) never matches the malformed name,
   so a genuinely direct dependency is shown as indirect.
2. **404 on diff loading.** The malformed name flows into the npm tarball URL
   builder and produces a registry request like
   `https://registry.npmjs.org/caniuse-lite@^1.0.30001702, caniuse-lite/-/...`,
   which fails with `Error: Failed to download tarball`.

The issue is reported against Yarn Berry, but Yarn 1 uses the same merged-key
serialization through the same parser, so both formats are in scope.

## Root cause

For the merged key

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

`splitPackage` returns:

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

- Only `name` from `splitPackage` is consumed by the Yarn loaders; the
  version always comes from the entry body (`version:` field /
  `version "..."` line). The garbage `version` return value is harmless on
  the Yarn path.
- `pkg.replace('@npm:', '@')` (`common.ts:44`) replaces only the first
  occurrence, but a valid single coordinate contains at most one `@npm:`, so
  this is not a separate defect once descriptors are split. The defect is at
  the format boundary — the Yarn loader feeding a descriptor *collection* to
  a single-coordinate helper — and `replaceAll` would change the malformed
  output without restoring the missing boundary. No `replaceAll` change.
- The Berry case is a regression from commit `9797117` (`Fix scoped package
  support`), which replaced Berry-specific name extraction with the shared
  `splitPackage` call. The Yarn 1 case is a pre-existing instance of the same
  bug.
- Both parsers already exclude entries without a usable version
  (`yarn.ts:53`, `yarn.ts:84`); Berry already excludes `__metadata` and
  `@workspace:` keys (`yarn.ts:75`). The failure-semantics table below builds
  on these existing exclusions.

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

## Domain model: two identities per entry

Yarn's own conceptual separation, which the fix adopts:

| Term | Meaning |
|---|---|
| Descriptor | A requested package ident plus a range or protocol reference |
| Requested name | The ident under which a dependency was requested (`package.json` key) |
| Locator | The resolved package ident plus the reference identifying its source |
| Resolved name | The ident of the package the locator represents |
| Lock entry | One resolved locator and every descriptor mapped to it |

For an ordinary dependency the two names are equal. For an npm alias they
differ. Given `package.json`:

```json
{ "dependencies": { "my-alias": "npm:lodash@^4.0.0" } }
```

Berry produces:

```yaml
"lodash@npm:^4.0.0, my-alias@npm:lodash@^4.0.0":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
```

- **Direct detection** needs the *requested* name (`my-alias`) — that is what
  appears in `package.json`.
- **Registry fetching, diffs, and display** need the *resolved* name
  (`lodash`) — that is whose tarball changed.

One `name` cannot serve both consumers. The model:

```text
Dependency.name   = resolved package name
Dependency.direct = package.json contains any requested name
```

No alias field is added to `Dependency` or `Change`. For an aliased
dependency the UI shows `lodash`, not `my-alias` — the right default, since
the changed code is lodash's. If alias display becomes a requirement later,
it needs a second field (e.g. `declaredAs`), not a different `name`; the
registry path must keep receiving the real name.

## Design invariants

1. One lockfile entry emits at most one dependency.
2. Identical public resolved identities emit once per lockfile (see the
   coalescing decision below for scope).
3. Descriptor count never determines dependency count.
4. `Dependency.name` identifies the resolved package used by npm loading.
5. `Dependency.direct` is derived from requested package names.
6. Nested `@` characters in a locator reference do not affect its package
   ident.
7. An ambiguous identity is never resolved by arbitrary descriptor order
   (stage 2; stage 1 knowingly and temporarily violates this for alias keys,
   which are equally broken today).
8. Yarn-specific serialization does not leak into shared package-coordinate
   parsing.

## Resolved decisions

The two source documents disagreed on three points. Resolutions:

### 1. Yarn 1 alias naming: descriptor-target extraction, in stage 2

The plan document deferred Yarn 1 alias support to an optional stage 3 that
would parse the real name out of the `resolved` tarball URL path. The
specification's mechanism is adopted instead: parse the target ident from the
alias descriptor itself (`my-alias@npm:lodash@4.17.21` → `lodash`). It is
registry-independent — URL-path inference breaks on custom registries and
non-standard URL layouts — and nearly free, because `parseCoordinate` already
handles `npm:lodash@^4.0.0` references for Berry. The old stage 3 is deleted;
its scope folds into stage 2.

### 2. Fallback policy: agreed target, then exclude with warning

The plan's first-descriptor fallback contradicted its own alias analysis
("if the alias sorts first, both consumers get the wrong name"). The
specification's agreed-target rule is strictly stronger and coincides with
first-descriptor on every same-ident merged key — the entire reported bug
class — so adopting it costs nothing in the common case.

For the residual corner (descriptor targets disagree *and* no usable
locator), the specification demanded silent exclusion. That is rejected:
multiocular is a dependency-review tool, and silently hiding an entry hides a
real change from the reviewer — worse than a mislabeled one. Resolution:
**exclude the entry and emit a warning** naming the source file and the raw
key, via the existing `warn()` helper (`server/cli/print.ts:20`, already used
from loader code at `server/loader/github.ts:42`). Exclusion stays
deterministic; the reviewer gets a signal to inspect the lockfile.

### 3. Cross-entry coalescing: gated on a verified fixture

The specification required an aggregation layer — group entries by (resolved
name, version, type, source lockfile), union requested names — motivated by
the claim that Yarn 1 can serialize an npm alias and its target as *separate
entries* which would otherwise emit two `Dependency` values with the same
name and version, producing duplicate `Change` records
(`calculateVersionDiff` in `server/loader/versions.ts` has no dedup by id).

That claim is load-bearing and unverified in both documents. Resolution:
**stage 2 starts with a verification task** — generate a real Yarn 1 lockfile
containing `lodash` plus `my-alias: npm:lodash@<same version>` and inspect
the serialization. If separate same-resolution entries are confirmed, the
coalescing step is implemented as part of stage 2 (it is a small
group-and-union over the parsed list, before `Dependency` construction). If
not, coalescing is dropped and invariant 2 relaxes to per-entry scope.

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

On top of it, two thin format helpers:

```ts
function parseMergedKey(key: string): string[] {
  return key.split(', ').map(stripQuotes)
}
```

- Berry joins descriptors with `", "`; npm semver ranges cannot contain a
  comma, so the split is unambiguous.
- Yarn 1 quotes each descriptor individually
  (`"@babel/core@^7.0.0", "@babel/core@^7.20.0":`), so quote-stripping
  happens per descriptor after the split, replacing the whole-string quote
  handling currently inside `splitPackage` (`common.ts:41-43`).

And alias-target extraction, shared by both formats:

```ts
function descriptorTarget(descriptor: { ident: string; reference: string }): string {
  if (descriptor.reference.startsWith('npm:')) {
    let inner = parseCoordinate(descriptor.reference.slice(4))
    // Alias form is npm:<ident>@<range>; a plain npm range contains no `@`,
    // so a non-empty inner reference marks an alias.
    if (inner.reference !== '') return inner.ident
  }
  return descriptor.ident
}
```

`npm:^1.0.0` → no inner `@` → target is the descriptor's own ident.
`npm:lodash@^4.0.0` → target `lodash`. `npm:@scope/pkg@^1.0.0` → target
`@scope/pkg` (scope marker skipped by `parseCoordinate`). Non-`npm:`
references (git, patch, portal, plain Yarn 1 ranges) → the descriptor's own
ident.

### Name and direct-flag policy

For each resolved lock entry (Berry):

- `name` = ident of the `resolution` locator, via `parseCoordinate`. The
  locator is authoritative: it names the package the entry actually
  represents, and outer-ident parsing is immune to nested `@` in the
  reference (git URLs, patch locators).
- Fallback when `resolution` is missing or unparsable: if every descriptor
  parses and all descriptor targets agree on one ident, use it; otherwise
  exclude the entry with a warning (decision 2).
- `direct` = true when **any** descriptor ident (the *requested* ident, not
  the alias target) from the merged key is in `directDeps`.
- Git handling unchanged (`yarn.ts:124-129`): `resolved`/`resolution`
  containing `github.com` or `git+` still swaps the version for the resolved
  URL.

For Yarn 1:

- `name` = the agreed descriptor target (`descriptorTarget` per descriptor;
  all must agree). Yarn 1 has no structured resolution — `resolved` is a
  fetch URL and is not used for identity (custom registries make URL-path
  inference unreliable). Disagreement → exclude with warning.
- `direct` = any requested descriptor ident in `directDeps`.

One `Dependency` per resolved lock entry, as today; plus the coalescing step
across entries if decision 3's verification confirms the Yarn 1
separate-entry case. Emitting one entry per descriptor stays rejected:
descriptors share the installed package, and `calculateVersionDiff` has no
dedup by id, so per-descriptor emission creates duplicate `Change` records.

### Failure semantics

Correctness takes precedence over inventing a plausible identity, but
exclusion is never silent (decision 2).

| Condition | Behavior |
|---|---|
| File-level syntax error detected by the format parser | Preserve the existing file-level parse failure |
| Metadata or workspace entry | Exclude (existing behavior, `yarn.ts:75`) |
| Entry without a usable version | Exclude (existing behavior, `yarn.ts:53`, `yarn.ts:84`) |
| Any descriptor in a key fails to parse | Exclude entry + `warn()` — directness would be incomplete |
| Berry locator parses | Use its resolved ident |
| Berry locator missing/invalid, all descriptor targets agree | Use the agreed target |
| Berry locator missing/invalid, targets disagree | Exclude entry + `warn()` |
| Yarn 1 descriptor targets agree | Use the agreed target |
| Yarn 1 descriptor targets disagree | Exclude entry + `warn()` |

## Staged delivery

The long-term design does not block the bug fix. Stages are independent.

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

Stage 1 mechanically uses first-descriptor selection — the pattern stage 2
replaces — but on same-ident merged keys (every input whose behavior stage 1
changes) first-descriptor and agreed-target produce identical output, so
stage 1 violates no stage 2 invariant on any input it affects.

### Stage 2 — structural parser and identity model

1. **Verify the Yarn 1 separate-entry claim** (decision 3): real Yarn 1
   lockfile with `lodash` + `my-alias: npm:lodash@<same version>`. Outcome
   selects or drops the coalescing step.
2. Replace `splitYarnPackage` and both `splitPackage` call sites in `yarn.ts`
   with `parseCoordinate` + `parseMergedKey` + `descriptorTarget` and the
   name/direct/failure policy above. Remove the `splitPackage` import from
   `yarn.ts`.
3. If step 1 confirmed: coalesce parsed entries by (resolved name, effective
   version, type, source lockfile), unioning requested names, before
   `Dependency` construction.
4. Remove the now-dead Yarn-quote handling from `splitPackage`
   (`common.ts:41-43`) only if pnpm fixtures confirm pnpm never feeds quoted
   input — otherwise leave it.

Stage 2 fixes, beyond stage 1: aliases in both formats (merged and unmerged),
correct `direct` for alias-declared deps, order-independent naming, correct
parsing of `patch:`/`portal:` locators, warned exclusion instead of garbage
output for malformed entries.

## Testability

All regression coverage sits at the public `yarn.load()` boundary with
in-memory branded `LoadedFile` fixtures — no Yarn binary, no registry, no
private exports. Every assertion checks the complete `Dependency` value
(`direct`, `from`, `name`, `source`, `type`, `version`) and the array length.
No grouped-key behavior is tested through `splitPackage` — that would
establish the wrong ownership boundary.

Fixture matrix (stage 1 subset marked ✦):

| Case | Format | Expectation |
|---|---|---|
| ✦ Issue's `caniuse-lite` merged key | Berry | one entry, `name: caniuse-lite`, `direct: true` |
| ✦ Scoped merged key (`@babel/core`) | Berry | one entry, scoped name intact |
| ✦ Merged key, unquoted | Yarn 1 | one entry, correct name |
| ✦ Merged key, per-descriptor quotes, scoped | Yarn 1 | one entry, correct name |
| ✦ Unmerged single-descriptor key (regression guard) | both | unchanged behavior |
| Alias merged key, alias declared in `package.json` | Berry | `name: lodash`, `direct: true` (stage 2) |
| Alias merged key, alias descriptor sorts first | Berry | same — order-independent (stage 2) |
| Alias unmerged key | Yarn 1 | `name: lodash` via descriptor target, `direct: true` (stage 2) |
| Entry without `resolution`, targets agree | Berry | agreed target used (stage 2) |
| Entry without `resolution`, targets disagree | Berry | entry excluded, `warn()` called (stage 2) |
| Yarn 1 grouped descriptors, targets disagree | Yarn 1 | entry excluded, `warn()` called (stage 2) |
| Git dependency with `resolution` | Berry | name correct, version = resolved URL (stage 2 regression guard) |
| Patch locator (`patch:lodash@npm%3A...`) | Berry | `name: lodash`, nested `@` ignored (stage 2) |
| Alias + target as separate entries | Yarn 1 | one coalesced dependency, `direct` from either (stage 2, only if decision 3 verification confirms the shape) |

`parseCoordinate`, `parseMergedKey`, and `descriptorTarget` are pure
functions and additionally get direct unit tests with the protocol zoo
(`npm:`, alias, scoped alias, `git@`, `patch:`, `portal:`, scoped idents,
malformed input) — cheap to enumerate, impossible to reach through
`yarn.load()` fixtures alone. They stay module-private; tests reach them
through `yarn.load()` where possible and a test-only export otherwise.

Existing integration tests (`yarn-berry.test.ts`, `yarn1.test.ts`) stay
as-is: they cover the real-binary end-to-end path; the new suite covers
parsing.

## Maintainability

- **Locality:** every Yarn serialization rule (merged keys, quoting,
  protocols, aliases) lives in one file next to the two parsers that need
  it. Deleting or upgrading Yarn support touches one module.
- **One parsing strategy:** `parseCoordinate` replaces three ad-hoc
  mechanisms (`lastIndexOf('@')`, `replace('@npm:')`, whole-string quote
  stripping) with one grammar-derived rule.
- **Explicit concepts:** requested and resolved identities have distinct
  names inside the Yarn loader and cannot be silently substituted. Alias
  behavior is a consequence of the model, not a special case.
- **Deterministic ambiguity handling:** fallback is agreement-based, never
  order-based; Yarn changing its descriptor sort order cannot silently
  change dependency identity.
- **Shared helper stays honest:** `splitPackage`'s doc comment and examples
  remain true; pnpm's behavior cannot be perturbed by Yarn fixes.
- **No defensive redundancy:** one mechanism per behavior — no
  belt-and-suspenders resolution-preference *plus* comma-split in the shared
  helper.

## Acceptance criteria

Stage 1:

- Issue fixture yields exactly one dependency: `caniuse-lite`,
  `1.0.30001750`, `direct: true` when declared in `package.json`.
- Grouped scoped keys correct in both formats; single-descriptor keys
  unchanged; existing integration tests pass.
- `splitPackage`, `eslint.config.ts`, public API, and dependency set
  unchanged.

Stage 2 (additional):

- Alias keys (merged or not, either format) yield the installed package name
  regardless of descriptor order, with `direct: true` when the alias is
  declared in `package.json`.
- Git/patch/portal resolutions never produce a name containing `@` past the
  scope marker.
- Ambiguous entries are excluded with a `warn()` naming file and key — never
  emitted under an arbitrary name, never dropped silently.
- If the Yarn 1 separate-entry shape is confirmed: equal public identities
  coalesce into one dependency preserving all requested names.
- `yarn.ts` no longer imports `splitPackage`; `splitPackage` and non-Yarn
  loaders keep their existing contracts.
- Full fixture matrix passes; format, type check, and full test suite pass
  in the required order (`./scripts/format.sh`, `pnpm test:types`,
  `pnpm test`).

## Rejected alternatives (consolidated)

- **Comma-split inside `splitPackage`:** works mechanically, but encodes
  Yarn serialization in a helper shared with pnpm and silently widens its
  documented contract. Superseded by stage 2's format-local parser.
- **Naive `resolution`-based naming via `splitPackage`:** regresses git
  dependencies (`nanoid@git@github.com:... → nanoid@git`) and still gets
  `direct` wrong for aliases. Correct only with outer-ident locator parsing
  — which is stage 2.
- **First-descriptor selection as the final policy:** descriptor order is a
  serialization artifact, not an identity guarantee; when differently named
  requests map to one locator it picks whichever sorts first. Acceptable
  only as stage 1's interim mechanism, where it changes behavior solely on
  same-ident keys.
- **Silent exclusion of ambiguous entries:** deterministic but hides a real
  change from a review tool; replaced by exclude-with-warning.
- **Yarn 1 alias names from `resolved` URL paths:** unreliable for custom
  registries and non-standard URL layouts; descriptor-target extraction is
  registry-independent and reuses `parseCoordinate`.
- **One dependency per merged descriptor:** duplicate `Dependency` values
  and duplicate `Change` ids downstream; the resolved entry is the unit
  multiocular compares.
- **`replaceAll('@npm:')`:** changes the symptom without restoring the
  descriptor boundary; a behavior change to shared code with zero fixtures
  demanding it.
- **Expanding the public dependency model (alias field):** the distinction
  is only needed while interpreting Yarn entries; a public field couples all
  loaders and UI consumers to a Yarn concern without improving current
  output.

## Scope boundaries

This design does not:

- expose requested aliases in `Dependency` or `Change`;
- redesign dependency identity for npm or pnpm lockfiles;
- detect a change whose only difference is direct versus transitive status;
- change npm tarball URL construction or git dependency fetching;
- emit multiple dependencies for multiple descriptors;
- attempt to recover identity from arbitrary Yarn 1 registry URLs.
