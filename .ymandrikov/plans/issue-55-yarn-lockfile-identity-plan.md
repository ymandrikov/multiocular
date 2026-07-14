# Issue #55: Yarn lockfile identity — authoritative design and staged plan

**Issue:** https://github.com/ai/multiocular/issues/55
**Status:** Approved design; authoritative
**Date:** 2026-07-14
**Supersedes:**

- `issue-55-yarn-grouped-descriptors-analysis.md`
- `issue-55-yarn-lock-merged-keys.md`
- `issue-55-yarn-descriptors-longterm.md`
- `issue-55-yarn-lockfile-identity-design.md`

## Decision

The Yarn loader will model requested and resolved package identities separately.
Yarn-specific parsing will move out of the shared `splitPackage` helper and into
a pure Yarn identity module.

For every valid Yarn lock entry, the loader will derive:

- every requested package name represented by the entry;
- one canonical resolved package name;
- one effective version;
- the existing fetch resolution, when present.

The public dependency keeps the existing shape:

```text
Dependency.name   = canonical resolved package name
Dependency.direct = package.json contains any requested package name
```

Before emitting dependencies, the loader will coalesce entries with the same
public resolved identity within one lockfile and union their requested names.
This makes public output independent of whether a Yarn version groups equivalent
requests into one entry or serializes them as separate entries.

Delivery is staged:

1. Ship a narrow grouped-key fix for issue #55.
2. Introduce structural descriptor and locator parsing with explicit identity
   selection.
3. Add cross-entry coalescing after per-entry behavior is covered.

Stage 1 can ship independently. Stages 2 and 3 form the long-term change and
should be implemented in separate, reviewable commits before being released
together.

## Problem

Yarn Berry and Yarn 1 can serialize multiple descriptors that resolve to the
same package as one comma-separated lockfile key:

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

The current Yarn parsers pass that entire key to `splitPackage`, which accepts
one coordinate. Its last-`@` search crosses the descriptor boundary and returns
this package name:

```text
caniuse-lite@^1.0.30001702, caniuse-lite
```

The malformed name causes two visible failures:

1. Direct-dependency detection fails because it does not match `caniuse-lite`
   from `package.json`.
2. Npm diff loading includes the malformed name in a registry URL and receives
   a 404 response.

The defect belongs to the Yarn format boundary. A grouped Yarn key is a
collection of descriptors, not a package coordinate. Changing `splitPackage`
or replacing every `@npm:` occurrence would alter the malformed string without
restoring the descriptor boundary.

## Domain model

| Term | Meaning |
|---|---|
| Descriptor | A requested package ident and its range or protocol reference |
| Requested name | The outer package ident under which a dependency was requested |
| Target name | The package ident named by descriptor semantics; differs from the requested name for an npm alias |
| Locator | A resolved package ident and the reference identifying its source |
| Resolved name | The package ident represented by the selected locator or agreed descriptor target |
| Lock entry | One serialized resolution and every descriptor mapped to it |
| Effective version | The entry version after preserving the loader's existing git-resolution behavior |
| Public dependency identity | Resolved name, effective version, and dependency type |

For an ordinary dependency, all three names agree:

```text
requested: caniuse-lite
target:    caniuse-lite
resolved:  caniuse-lite
```

For an npm alias, the requested name differs:

```text
package.json: "my-alias": "npm:lodash@^4.0.0"
descriptor:   my-alias@npm:lodash@^4.0.0
locator:      lodash@npm:4.17.21

requested: my-alias
target:    lodash
resolved:  lodash
```

The requested name determines directness. The resolved name determines change
identity, npm tarball loading, repository lookup, and display.

The distinction remains internal to the Yarn loader. This change does not add
an alias or locator field to `Dependency` or `Change`.

## Invariants

The implementation must preserve these rules:

1. One lock entry produces at most one parsed resolution.
2. Descriptor count never determines dependency count.
3. Equal public dependency identities emit once per lockfile.
4. Coalescing unions every requested name represented by its members.
5. `Dependency.name` is the canonical resolved name used by downstream npm
   loading.
6. `Dependency.direct` is derived from requested names, never from the resolved
   name alone.
7. Descriptor order never selects package identity.
8. Nested `@` characters in references never affect the outer package ident.
9. Ambiguous identity is excluded instead of guessed.
10. Yarn serialization rules do not change the contract of `splitPackage` or
    any non-Yarn loader.
11. Git resolutions remain distinct when their effective versions differ.
12. Non-git locators with the same public resolved identity intentionally
    coalesce because the current public model cannot represent a locator-level
    distinction.

If locator-level differences must become visible later, the public dependency
model and diff identity must be expanded explicitly. They must not be smuggled
into this loader's aggregation key.

## Architecture

The implementation has three responsibilities.

### Lockfile format parsing

`server/loader/versions/yarn.ts` continues to:

- detect Yarn Berry or Yarn 1;
- parse raw lock entries;
- exclude metadata and workspaces;
- read manifests and direct dependency names;
- preserve existing git-version handling;
- construct branded `Dependency` values.

Format parsing produces a discriminated raw-entry union for Berry and Yarn 1.
It preserves the grouped key, version, and format-specific resolution without
choosing a package identity while scanning the lockfile.

### Yarn identity parsing

A new pure `server/loader/versions/yarn-identity.ts` module owns:

- grouped-key splitting and Yarn 1 quote handling;
- outer descriptor parsing;
- npm alias target parsing;
- Berry locator parsing;
- canonical-name selection;
- ambiguity detection.

Its internal string concepts use distinct branded TypeScript types so requested
names, target names, resolved names, references, descriptors, and locators
cannot be substituted accidentally.

Parsing and selection return discriminated success or failure values. They do
not use optional content to represent a failed parse, and they never use
unchecked casts or `as any`.

The module has no filesystem, process, registry, or diff-loading dependency.
It exports only the specific functions and types needed by `yarn.ts` and its
tests. TypeScript imports include the `.ts` extension and no default export is
introduced.

### Resolution aggregation

The Yarn loader aggregates valid parsed resolutions separately for each source
lockfile. Within that scope, the key contains:

- canonical resolved name;
- effective version;
- dependency type.

Each aggregate unions requested names. Directness is calculated after the union
so a direct alias and a transitive target, or the reverse, produce one direct
dependency.

Aggregation happens after existing git handling chooses the effective version.
Different git commits therefore remain distinct. Equal non-git public
identities coalesce even when their raw locator references differ. Scoping the
aggregation to one source lockfile preserves monorepo boundaries while the key
matches the identity visible to `calculateVersionDiff` and npm loading.

## Structural parsing

### Outer coordinates

A Yarn descriptor or locator has an outer `ident@reference` structure. A
scoped ident can contain only its leading scope marker before the separator.
The outer separator is therefore the first `@` after the scope, not the final
`@` in the complete string.

Conceptually:

```ts
function splitOuter(input: string): ParseResult<YarnCoordinate> {
  let at = input.indexOf('@', input.startsWith('@') ? 1 : 0)
  if (at === -1) return { invalid: true }
  return {
    invalid: false,
    value: {
      ident: yarnIdent(input.slice(0, at)),
      reference: yarnReference(input.slice(at + 1))
    }
  }
}
```

The real implementation must validate that the ident and reference are usable.
The example only establishes the separator rule.

This strategy preserves the outer ident for references containing nested `@`
characters, including:

- `npm:^1.0.0`;
- `npm:lodash@^4.0.0`;
- `git@github.com:ai/nanoid.git#commit=abc`;
- `patch:lodash@npm%3A4.17.21#...`;
- `portal:` and `workspace:` references.

### Grouped keys

Berry grouped keys are split on Yarn's exact `, ` serialization delimiter after
YAML parsing. Yarn 1 headers use the same descriptor delimiter but can quote
each descriptor separately, so quotes are stripped per descriptor after the
split.

The implementation must reject empty members, unmatched quotes, and members
without a valid requested ident. It must not silently drop one malformed member
and retain incomplete directness information for the rest of the entry.

### Descriptor targets

Every descriptor yields:

- the outer requested name;
- a target name;
- the remaining reference.

For an ordinary descriptor, the target name equals the requested name. For an
npm alias reference of the form `npm:<target-ident>@<selector>`, the target name
is `<target-ident>`. Scoped alias targets use the same outer-coordinate rule.

Alias detection must be structural. It must not infer a target from arbitrary
registry URLs or assume that every nested `@` belongs to an npm alias.

### Berry locators

When a Berry `resolution` locator parses successfully, its outer ident is the
canonical resolved name. Descriptor names remain relevant for directness and
fallback only.

If the locator is missing or invalid, fallback succeeds only when:

- every descriptor parses completely; and
- every descriptor target agrees on one name.

If targets disagree, the entry is ambiguous and is excluded.

### Yarn 1 identities

Yarn 1's `resolved` field is a fetch URL rather than a Yarn locator. Custom
registries make URL-path identity inference unreliable, so it is not used as a
package-name source.

The canonical resolved name comes from descriptor targets. Every target must
agree. This supports ordinary and npm-alias descriptors without depending on a
registry URL layout.

When Yarn 1 serializes an alias and its target as separate entries, each entry
is parsed independently and the aggregation phase coalesces their equal public
resolved identities.

## Failure semantics

Correctness takes precedence over inventing a plausible identity.

| Condition | Behavior |
|---|---|
| File-level syntax error | Preserve the existing file-level parse failure |
| Metadata or workspace entry | Exclude it |
| Entry without a usable version | Exclude it |
| Malformed grouped key | Exclude the complete entry |
| Descriptor without a requested name | Exclude the complete entry |
| Descriptor without a target name | Exclude the complete entry |
| Valid Berry locator | Use its outer ident as the resolved name |
| Missing or invalid Berry locator with one agreed target | Use the agreed target |
| Missing or invalid Berry locator with conflicting targets | Exclude the entry |
| Yarn 1 descriptors with one agreed target | Use the agreed target |
| Yarn 1 descriptors with conflicting targets | Exclude the entry |

Entry exclusion remains local to the invalid entry. A malformed entry does not
invalidate unrelated valid entries unless the format parser already treats the
file as syntactically invalid.

## Staged delivery

### Stage 1 — issue #55 hotfix

Add a Yarn-local helper that selects the first serialized descriptor using the
exact `, ` delimiter before passing that single descriptor to `splitPackage`.
Both Yarn parsers use the helper.

This stage fixes:

- the reported Berry `caniuse-lite` key;
- grouped scoped Berry keys;
- grouped Yarn 1 keys, including per-descriptor quotes;
- directness when grouped descriptors share the same requested name.

This stage intentionally does not fix aliases. It preserves their current
behavior and does not change:

- `splitPackage`;
- pnpm parsing;
- public types or APIs;
- dependency declarations;
- `eslint.config.ts`.

Stage 1 should be released independently so the reported registry 404 is not
blocked by the identity refactor.

### Stage 2 — structural identity parser

Introduce `yarn-identity.ts`, change both format parsers to retain grouped keys,
and select canonical identities using the rules above.

Stage 2 delivers:

- all requested names from grouped keys;
- structural outer-ident parsing;
- Berry locator authority;
- npm alias target parsing for Berry and Yarn 1;
- consensus-based fallback;
- deterministic exclusion of ambiguous entries;
- removal of the `splitPackage` import from `yarn.ts`.

At this stage one valid parsed resolution still corresponds to one lock entry.
Tests establish the per-entry identity behavior before cardinality changes.

### Stage 3 — public-identity aggregation

Add per-lockfile aggregation after effective-version calculation. Union
requested names before calculating directness and emit one dependency per
public resolved identity.

Stage 3 delivers:

- one dependency for separate Yarn 1 alias and target entries;
- serialization-independent output cardinality;
- deterministic directness across coalesced entries;
- protection against duplicate `Change` records caused by equal `after`
  dependencies.

Stage 3 belongs in the same long-term pull request as Stage 2 but in a separate
commit with its own focused tests.

## Data flow

```text
yarn.lock
  -> detect Berry or Yarn 1
  -> parse raw lock entries
  -> split grouped keys into descriptors
  -> parse requested names and descriptor targets
  -> parse the Berry locator when available
  -> select or reject one canonical resolved name per entry
  -> preserve existing git effective-version handling
  -> coalesce equal public dependency identities per lockfile
  -> union requested names
  -> calculate directness from requested names
  -> emit one branded Dependency per aggregate
  -> calculateVersionDiff compares resolved names and versions
  -> npm loading receives the resolved registry package name
```

## Test strategy

All new regression tests are deterministic and offline. Existing real-Yarn
integration tests remain unchanged.

### Stage 1 loader fixtures

Tests call `yarn.load()` with in-memory branded `LoadedFile` values and assert
the complete `Dependency` value and array length.

| Scenario | Format | Expected result |
|---|---|---|
| Issue `caniuse-lite` grouped key | Berry | One direct `caniuse-lite@1.0.30001750` |
| Grouped scoped key | Berry | Scoped name preserved |
| Grouped unquoted key | Yarn 1 | First descriptor name parsed correctly |
| Grouped per-descriptor quoted scoped key | Yarn 1 | Scoped name preserved |
| Single descriptor | Both | Existing behavior unchanged |

### Pure identity tests

Pure tests import named functions from `yarn-identity.ts` and cover:

- scoped and unscoped outer idents;
- ordinary npm descriptors;
- unscoped and scoped npm aliases;
- repeated and differently named requests in grouped keys;
- Yarn 1 per-descriptor quotes;
- nested `@` characters in git and patch references;
- portal and workspace references;
- Berry locator authority over descriptor order;
- agreed descriptor-target fallback;
- conflicting descriptor targets;
- malformed descriptors, locators, quotes, and grouped members.

### Long-term loader fixtures

Tests through `yarn.load()` cover:

| Scenario | Expected result |
|---|---|
| Berry alias declared in `package.json` | Resolved name with `direct: true` through alias |
| Berry alias and target requests in one key | One dependency independent of descriptor order |
| Yarn 1 alias descriptor | Alias target used as resolved name |
| Separate Yarn 1 alias and target entries | One coalesced dependency with unioned requested names |
| Missing Berry locator with agreed targets | One fallback dependency |
| Missing Berry locator with conflicting targets | Entry excluded |
| Conflicting Yarn 1 targets | Entry excluded |
| Two equal non-git public identities with different locators | One dependency, documenting current public identity |
| Two git resolutions with different effective versions | Two distinct dependencies |
| Existing git dependency | Name unchanged and version remains the resolved URL |

### Existing integration tests

`server/test/yarn-berry.test.ts` and `server/test/yarn1.test.ts` continue to
cover real CLI loading, registry access, diff generation, ordinary packages,
scoped packages, and existing git behavior. Grouped-key and identity cases do
not invoke Yarn or access a registry.

## Acceptance criteria

### Stage 1

- The issue fixture emits exactly one direct `caniuse-lite@1.0.30001750`
  dependency.
- Grouped scoped keys work in Berry and Yarn 1.
- Single-descriptor behavior remains unchanged.
- `splitPackage`, pnpm, public APIs, dependencies, and `eslint.config.ts` remain
  unchanged.

### Stages 2 and 3

- `Dependency.name` always contains the canonical resolved package name.
- Directness considers every requested name represented by an aggregate.
- Berry aliases use the locator ident and remain direct through a declared
  alias.
- Yarn 1 aliases derive their target from descriptor syntax, never a fetch URL.
- Descriptor order cannot change canonical identity.
- Missing-locator fallback requires complete target agreement.
- Ambiguous entries are excluded rather than assigned an arbitrary name.
- Nested locator references cannot add `@` characters to the resolved name
  after the scope marker.
- Equal public identities within one lockfile emit once and preserve all
  requested names.
- Different git effective versions do not coalesce.
- `yarn.ts` no longer imports `splitPackage`.
- `Dependency`, `Change`, `calculateVersionDiff`, npm loading, pnpm loading, and
  the shared helper keep their current contracts.
- New coverage is deterministic and offline.
- Verification passes in this order:
  `./scripts/format.sh`, `pnpm test:types`, `pnpm test`.

## Risks and controls

### Stage 1 remains intentionally incomplete

Selecting the first descriptor repairs grouped entries whose descriptors share
one requested name, but it does not establish a general identity rule. The
helper is temporary and must be removed by Stage 2.

### Exclusion can hide an ambiguous dependency

The long-term parser skips an entry rather than emitting a guessed name. Tests
must cover every exclusion condition so valid common protocols are not rejected
accidentally. If users need diagnostics later, structured loader warnings are a
separate product change.

### Aggregation changes cardinality

Coalescing can reduce duplicate dependencies that the current loader exposes.
Stage 3 remains separate from parsing so review and tests can isolate this
behavior. The aggregation key mirrors the identity currently visible to
downstream comparison.

### Yarn syntax can evolve

Protocol assumptions live in one pure module with explicit protocol-zoo tests.
Unknown but structurally valid references retain their outer ident. Syntax that
cannot establish requested and resolved identity is rejected deterministically.

## Rejected alternatives

### Change `splitPackage`

Grouped keys, quoting, descriptors, locators, and aliases are Yarn concepts.
Adding them to the shared single-coordinate helper would widen its contract and
couple pnpm to Yarn serialization.

### Keep the first descriptor as the long-term identity

The first descriptor is sufficient only when every descriptor means the same
package. Serialization order is not an identity guarantee and cannot resolve
aliases or conflicting targets.

### Use the Berry locator for both name and directness

The locator supplies the installed package name but loses alias names declared
in `package.json`. Directness must remain a separate calculation over requested
names.

### Infer Yarn 1 package names from `resolved` URLs

Registry URL layouts are not part of Yarn descriptor semantics and vary across
custom registries. Npm alias targets are already encoded in descriptors and can
be parsed without URL heuristics.

### Emit one dependency per descriptor

Descriptors are requests, not installed package instances. Per-descriptor
emission duplicates public dependencies and can create duplicate changes.

### Preserve one dependency per lock entry forever

Yarn versions can serialize equivalent resolutions with different entry
cardinality. Keeping that artifact visible makes Berry and Yarn 1 produce
different public results for the same logical dependency graph.

### Expand `Dependency` or `Change`

Requested names and raw locators are needed only while interpreting Yarn.
Exposing them across every loader and UI consumer would increase coupling
without improving the current issue's output.

## Scope boundaries

This design does not:

- expose requested aliases or locators publicly;
- redesign npm or pnpm dependency identity;
- detect a change whose only difference is direct versus transitive status;
- change npm tarball URL construction;
- change git fetching or version selection;
- recover package identity from arbitrary registry URLs;
- add dependencies;
- change lint configuration.
