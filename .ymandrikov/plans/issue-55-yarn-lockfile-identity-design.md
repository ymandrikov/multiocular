# Issue #55 Yarn Lockfile Identity Design

**Issue:** https://github.com/ai/multiocular/issues/55  
**Status:** Proposed long-term fix  
**Scope:** Bug correctness, architecture, testability, and maintainability

## Decision

Model Yarn lockfile descriptors and locators as different concepts.

For each lockfile entry, the Yarn loader will derive:

- one resolved package name for `Dependency.name`;
- every requested package name represented by the entry;
- one resolved version;
- the existing fetch resolution, when present.

Before constructing public dependencies, the loader coalesces entries that
produce the same public resolved name and version. Their requested names are
combined so directness remains accurate. This matters for Yarn 1, which can
serialize an npm alias and its target as separate entries even when Yarn Berry
groups the equivalent requests under one locator.

The resolved package name remains the public dependency name used for change
identity, npm downloads, repository lookup, and display. Directness is computed
separately: a dependency is direct when any requested package name from the
aggregated resolution appears in `package.json`.

Grouped-key parsing and Yarn locator parsing remain Yarn-specific. The shared
`splitPackage` helper keeps its current single-coordinate contract.

## Problem

Yarn can serialize multiple dependency descriptors into one lockfile key when
they resolve to the same package locator. The issue fixture contains this key:

```text
caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746
```

The current Yarn loader passes the entire key to `splitPackage`, which expects
one package coordinate. Its last-`@` search crosses the descriptor boundary and
produces this name:

```text
caniuse-lite@^1.0.30001702, caniuse-lite
```

That malformed name has two observable effects:

1. Direct-dependency detection fails because the name does not match
   `caniuse-lite` in `package.json`.
2. Npm diff loading builds a tarball URL containing the malformed name and
   receives a 404 response.

Yarn Berry and Yarn 1 both support grouped lockfile keys and both currently
send those keys through the same single-coordinate parser.

### The defect is at the format boundary

`splitPackage` is not defective because it replaces only the first `@npm:`
occurrence. A valid input to that helper contains one package coordinate and
therefore at most one Yarn npm protocol marker that needs normalization.

The defect is that the Yarn loader passes a serialized descriptor collection
to a helper whose contract covers one coordinate. Using `replaceAll` would
change the malformed output without restoring the missing descriptor boundary.

## Domain Model

The long-term fix uses Yarn's own conceptual separation between descriptors
and locators.

| Term | Meaning |
| --- | --- |
| Descriptor | A requested package ident plus a range or protocol reference |
| Requested name | The package ident under which a dependency was requested |
| Locator | The resolved package ident plus the reference that identifies its source |
| Resolved name | The package ident of the package represented by the locator |
| Lock entry | One resolved package locator and every descriptor mapped to it |

For an ordinary dependency, requested and resolved names are equal:

```text
requested: caniuse-lite
resolved:  caniuse-lite
```

For an npm alias, they differ:

```text
requested: my-alias
resolved:  lodash
```

This distinction matters because Multiocular currently uses one public name for
both directness and npm package loading. The new design keeps the public name as
the resolved package name but calculates directness from requested names before
constructing the public `Dependency`.

The public dependency model remains unchanged:

```text
Dependency.name   = resolved package name
Dependency.direct = package.json contains any requested name
```

No alias field is added to `Dependency` or `Change`.

## Design Invariants

The parser and loader must preserve these invariants:

1. One lockfile entry emits at most one dependency.
2. Identical public resolved identities emit once per lockfile.
3. Coalescing resolved identities unions their requested names.
4. Descriptor count never determines dependency count.
5. `Dependency.name` identifies the resolved package used by npm loading.
6. `Dependency.direct` is derived from requested package names.
7. Nested `@` characters in a locator reference do not affect its package
   ident.
8. An ambiguous identity is never resolved by arbitrary descriptor order.
9. Yarn-specific serialization does not leak into shared package-coordinate
   parsing.

## Architecture

The Yarn versions loader is divided into three responsibilities.

### Lockfile format parsing

The format parser recognizes Yarn Berry or Yarn 1 and extracts raw entries. It
does not decide package identity while scanning YAML or Yarn 1 lines.

Each raw entry contains:

- the grouped key;
- the version from the entry body;
- the Berry locator or Yarn 1 fetch resolution when present.

Format detection, metadata exclusion, and workspace exclusion remain at this
layer.

### Yarn identity parsing

A pure Yarn-specific parser interprets descriptor and locator syntax.

Descriptor parsing returns:

- the requested outer ident;
- the target package ident when the descriptor expresses an npm alias;
- the remaining range or protocol reference without treating nested `@`
  characters as ident separators.

Locator parsing returns the outer package ident independently of the locator
reference. This works for ordinary npm locators and for references containing
nested source locators, such as patch locators.

Grouped-key parsing returns all descriptors represented by the key. Requested
names are deduplicated as a set because several ranges commonly request the
same package.

### Resolution aggregation and dependency construction

The loader first groups parsed Yarn resolutions by the identity visible to
downstream comparison: resolved name, effective version, dependency type, and
source lockfile. It unions the requested names of every member.

This aggregation makes entry serialization irrelevant to public cardinality.
Yarn Berry may place an alias and its target in one grouped key while Yarn 1
places them in separate entries; both representations produce one public
resolved dependency when their public identity is otherwise equal.

The loader then converts each aggregated Yarn resolution into the existing
`Dependency` shape:

```text
name    = canonical resolved name
version = entry body version, subject to existing git handling
direct  = requested names intersect direct dependency names
```

The temporary internal representation carries both identities but does not
expose them beyond the Yarn loader boundary.

## Canonical Name Selection

### Yarn Berry

The Berry `resolution` locator is authoritative because it names the package
actually represented by the entry. The grouped key describes requests for that
package and is used for directness, not as the primary resolved-name source.

This rule handles:

- ordinary grouped ranges;
- scoped packages;
- npm aliases;
- descriptors redirected to another locator;
- locator references containing additional `@` characters.

If `resolution` is absent or cannot be parsed, the loader derives target names
from the descriptors. It accepts the fallback only when every descriptor
parses and all target names agree on one package ident.

### Yarn 1

Yarn 1's `resolved` field is a fetch URL rather than a Yarn package locator. It
is not used as a general package-name source because custom registries and URL
layouts make path-based identity inference unreliable.

The resolved name is derived from descriptor semantics:

- an ordinary descriptor targets its requested ident;
- an npm alias descriptor targets the package ident inside its npm reference;
- grouped descriptors must agree on one target ident.

If the descriptors imply different target idents and no authoritative locator
exists, the entry is ambiguous and is not emitted.

## Direct-Dependency Semantics

Directness is evaluated against every requested name, not the resolved name.

For the issue fixture, both descriptors request `caniuse-lite`, so a manifest
dependency named `caniuse-lite` marks the resolved package direct.

For an alias:

```text
package.json dependency: "my-alias": "npm:lodash@4.17.21"
lockfile request:         my-alias@npm:lodash@4.17.21
resolved locator:         lodash@npm:4.17.21
```

The emitted dependency has:

```text
name:   lodash
direct: true
```

This preserves the real npm package name required by tarball and repository
loading while respecting how the application declared the dependency.

When a grouped entry contains both direct and transitive requests, any matching
requested name makes the single resolved dependency direct. This is consistent
with the current name-based meaning of `direct`.

When Yarn 1 stores the alias and target as separate entries, aggregation unions
their requested names before applying the same rule. The result does not depend
on whether a Yarn version grouped equivalent requests during serialization.

## Failure Semantics

Correctness takes precedence over inventing a plausible identity.

| Condition | Behavior |
| --- | --- |
| File-level syntax error detected by the format parser | Preserve the existing file-level parse failure |
| Metadata or workspace entry | Exclude it |
| Entry without a usable version | Exclude it |
| Malformed grouped key | Exclude the entry |
| Any descriptor cannot provide a requested ident | Exclude the entry because directness would be incomplete |
| Berry locator parses successfully | Use its resolved ident |
| Berry locator missing or invalid, all descriptor targets agree | Use the agreed target ident |
| Berry locator missing or invalid, descriptor targets disagree | Exclude the ambiguous entry |
| Yarn 1 descriptor targets agree | Use the agreed target ident |
| Yarn 1 descriptor targets disagree | Exclude the ambiguous entry |

Exclusion is preferable to selecting the first descriptor because Yarn orders
grouped descriptors for serialization. That order is not an identity guarantee
and can change without changing the resolved package.

## Data Flow

```text
yarn.lock
  -> detect Berry or Yarn 1
  -> parse raw lock entries
  -> split each grouped key into descriptors
  -> parse requested names and descriptor targets
  -> parse the Berry locator when available
  -> select one canonical resolved name
  -> coalesce equal public resolved identities and union requested names
  -> calculate directness from every requested name
  -> emit one Dependency for the aggregated public identity
  -> calculateVersionDiff matches by resolved name and version
  -> npm loading receives the resolved registry package name
```

The data flow prevents requested ranges, aliases, and grouped-key punctuation
from crossing into change calculation or npm URL construction.

## Component Boundaries

The maintainable boundary is a Yarn-specific pure parser alongside a thin
versions-loader adapter.

| Component | Responsibility |
| --- | --- |
| Yarn lock parser | Parse Berry and Yarn 1 entries into raw lock data |
| Yarn identity parser | Parse grouped descriptors, aliases, and locators into requested and resolved identities |
| Yarn versions loader | Read manifests, preserve git handling, coalesce public identities, calculate directness, and construct `Dependency` values |
| Shared `splitPackage` | Parse one non-grouped package coordinate for existing callers |

The identity parser has no filesystem, registry, process, or diff-loading
dependencies. It can be tested with strings and plain values.

The existing `yarn` loader remains the public integration boundary. Parser
helpers do not need to become part of the package's public API.

## Correctness Scenarios

| Scenario | Resolved name | Requested names | Result |
| --- | --- | --- | --- |
| Berry grouped `caniuse-lite` ranges | `caniuse-lite` | `caniuse-lite` | One dependency |
| Berry grouped scoped ranges | `@babel/core` | `@babel/core` | One dependency |
| Yarn 1 grouped ranges | `caniuse-lite` | `caniuse-lite` | One dependency |
| Berry alias to lodash | `lodash` | `my-alias` | One dependency; direct through alias |
| Berry direct lodash plus alias to lodash | `lodash` | `lodash`, `my-alias` | One dependency; direct if either is declared |
| Yarn 1 direct lodash plus alias to lodash | `lodash` | `lodash`, `my-alias` | Separate entries coalesce into one dependency |
| Berry patch locator for lodash | `lodash` | `lodash` | Nested locator syntax does not alter the name |
| Missing Berry locator with one agreed target | Agreed target | All requests | One fallback dependency |
| Missing Berry locator with conflicting targets | None | Conflicting requests | Entry excluded |
| Yarn 1 conflicting targets | None | Conflicting requests | Entry excluded |

## Test Model

The design uses two deterministic test layers and retains existing integration
coverage.

### Pure identity tests

Pure tests cover the grammar and selection rules independently of file loading:

- unscoped and scoped descriptors;
- ordinary npm descriptors;
- npm alias descriptors;
- grouped keys with repeated requested names;
- grouped keys with different requested names;
- locators with nested `@` characters;
- agreed descriptor-target fallback;
- ambiguous descriptor targets;
- malformed descriptors and locators.

These tests make protocol and delimiter assumptions visible. A parser change
can be evaluated without constructing `LoadedFile` values or running the full
loader.

### Public loader contract tests

Tests through `yarn.load()` cover behavior visible to the rest of Multiocular:

- the exact issue #55 Berry fixture;
- the equivalent Yarn 1 fixture;
- grouped scoped packages in both formats;
- exactly one emitted dependency per grouped entry;
- directness for ordinary grouped descriptors;
- resolved naming and directness for npm aliases;
- coalescing of separate Yarn 1 alias and target entries;
- Berry locator authority over descriptor order;
- unambiguous missing-locator fallback;
- exclusion of ambiguous entries;
- unchanged single-descriptor behavior.

Assertions cover complete `Dependency` values so that name, directness, source,
loader, type, and version cannot regress independently.

### Existing integration tests

The existing Yarn Berry and Yarn 1 integration tests remain coverage for CLI
loading, registry downloads, diff generation, and ordinary single descriptors.
New grouped-key and identity tests remain in-memory and do not invoke Yarn or
access a package registry.

No grouped-key behavior is tested through `splitPackage`, because such tests
would establish the wrong ownership boundary.

## Maintainability

### Explicit concepts

Requested and resolved identities receive distinct names and cannot be
accidentally substituted without crossing a typed internal boundary. Alias
behavior is a normal consequence of the model rather than a special case in
direct-dependency detection.

### Stable shared contracts

`splitPackage`, pnpm parsing, `Dependency`, `Change`, diff calculation, and npm
loading keep their existing contracts. Yarn syntax changes remain localized to
the Yarn parser.

### Protocol resilience

The resolved ident is parsed from the outer locator structure rather than by
searching for the final `@`. Nested locators and protocol references can evolve
without changing which package ident the entry represents.

### Deterministic ambiguity handling

Fallback selection is based on agreement among descriptor targets, not key
order. Future changes to Yarn's descriptor sorting therefore cannot silently
change dependency identity.

### Serialization-independent cardinality

Aggregation follows the public dependency identity rather than the number of
keys chosen by a Yarn version. Equivalent Berry and Yarn 1 lockfiles therefore
cannot produce different numbers of public changes merely because one format
groups descriptors and the other does not.

### No additional dependency

The required grammar is limited to Yarn descriptor grouping, outer idents, and
npm alias targets. It can be represented by small pure functions using the
existing TypeScript and YAML stack.

## Alternatives Rejected

### Always select the first descriptor

This fixes the reported fixture and ordinary grouped ranges, but descriptor
order is not a reliable resolved-identity source. It fails when differently
named requests map to one locator and hides ambiguity when no locator exists.

### Teach `splitPackage` about grouped Yarn keys

This places Yarn serialization inside a shared single-coordinate helper and
changes pnpm-adjacent behavior without need. It also cannot distinguish
requested identity from resolved identity.

### Parse every Berry resolution with `splitPackage`

`splitPackage` searches from the final `@` to support scoped coordinates. Yarn
locator references may themselves contain locators or URLs with additional
`@` characters. A locator requires outer-ident parsing rather than
single-coordinate version splitting.

### Replace every `@npm:` occurrence

This changes the symptom but does not parse the descriptor collection. It does
not restore correct names, directness, or entry cardinality.

### Emit one dependency per descriptor

Descriptors are requests, not installed package instances. Emitting one result
per request duplicates one resolved package and can create duplicate changes.

### Expand the public dependency model

Adding requested aliases or locators to every `Dependency` and `Change` would
make the distinction visible across all loaders and UI consumers. The current
bug only requires the distinction while interpreting Yarn entries, so a public
model expansion would add coupling without improving current output.

## Acceptance Criteria

- The issue fixture emits one direct `caniuse-lite@1.0.30001750` dependency.
- The equivalent Yarn 1 entry emits the same logical dependency.
- Grouped scoped descriptors retain their complete scoped name.
- Descriptor order does not determine the resolved package name.
- Berry aliases emit the resolved npm package name.
- A manifest-declared alias can mark the resolved package direct.
- Locators containing nested `@` characters retain the outer package ident.
- Missing-locator fallback succeeds only for one agreed descriptor target.
- Ambiguous entries do not emit an arbitrarily named dependency.
- One lock entry never emits duplicate dependencies.
- Equal public identities from separate Yarn 1 entries coalesce and preserve
  all requested names.
- Existing ordinary Yarn and git-version behavior remains unchanged.
- `splitPackage` and non-Yarn loaders retain their existing contracts.
- New regression coverage is deterministic and does not require Yarn or a
  registry.

## Scope Boundaries

This design does not:

- expose requested aliases in `Dependency` or `Change`;
- redesign dependency identity for npm or pnpm lockfiles;
- detect a change whose only difference is direct versus transitive status;
- change npm tarball URL construction;
- change git dependency fetching;
- emit multiple dependencies for multiple descriptors;
- attempt to recover a resolved identity from arbitrary Yarn 1 registry URLs.

Those concerns can be addressed separately if their product behavior becomes
necessary. They are not prerequisites for a correct, maintainable resolution
of issue #55.
