# Task 1 Report: Structural Identity Parser and Loader Integration

## Status

DONE_WITH_CONCERNS

## Implementation summary

- Added a pure structural Yarn identity resolver with branded requested and resolved names.
- Parsed grouped Classic and Berry descriptors without using `splitPackage` for identity selection.
- Added npm alias-target extraction, Berry locator authority, agreed-target fallback, requested-name deduplication, and invalid-entry results.
- Integrated identity resolution into the public `yarn.load()` path.
- Preserved first-seen lock-entry order, alias directness, public `Dependency` output, and git effective versions.
- Added warnings that include the lockfile path and raw entry key when malformed or ambiguous entries are excluded.
- Did not add cross-entry coalescing; that remains Task 2 scope.

## Files changed

- `server/loader/versions/yarn-identity.ts`: new pure identity parser and exported branded/discriminated types.
- `server/loader/versions/yarn.ts`: raw-entry parsing plus identity resolver integration and warning behavior.
- `server/test/yarn.test.ts`: eight public loader integration tests.

No unrelated file was staged or committed.

## TDD evidence

### RED

Command:

```sh
pnpm bnt server/test/yarn.test.ts -t 'loads the grouped Berry issue fixture'
```

Result: exit 1, 1 test run, 0 pass, 1 fail.

Relevant output:

```text
✖ loads the grouped Berry issue fixture
ℹ tests 1
ℹ pass 0
ℹ fail 1

actual:
direct: false
name: 'caniuse-lite@^1.0.30001702, caniuse-lite'

expected:
direct: true
name: 'caniuse-lite'
```

This was the expected failure: the old loader passed the grouped Berry key through `splitPackage`, producing the combined name and losing directness.

### GREEN

Command:

```sh
pnpm bnt server/test/yarn.test.ts
```

Result: exit 0, 8 tests run, 8 pass, 0 fail.

Relevant output:

```text
✔ loads the grouped Berry issue fixture
✔ loads grouped quoted scoped Yarn 1 descriptors
✔ uses a Berry locator and alias directness
✔ uses a Yarn 1 alias target and alias directness
✔ uses locator authority and missing-locator fallback
✔ falls back to agreed targets after an unparseable locator
✔ preserves an existing git effective version
✔ warns and excludes unparseable or ambiguous entries
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

The same eight tests also passed in the formatted production build exercised by the final full-suite run.

## Repository verification

Commands were run in the required order.

### Format

Command:

```sh
/bin/bash ./scripts/format.sh
```

Result: exit 0.

```text
Finished in 39ms on 3 files using 18 threads.
```

The explicit Bash invocation was used because the repository script's `/usr/bin/bash` shebang is unavailable in this environment.

### Types

Command:

```sh
pnpm test:types
```

Result: exit 0, 0 errors and 1 existing warning.

```text
svelte-check found 0 errors and 1 warning in 1 file
```

The warning is the existing unknown CSS property `corner-shape` in `web/ui/button.svelte`.

### Full suite

Initial sandboxed command:

```sh
pnpm test
```

Result: exit 1 because `test:audit` could not resolve `registry.npmjs.org` and ended with `ENOTFOUND`. Per the sandbox instructions, the same command was rerun with approved external network access.

Final externally networked command:

```sh
pnpm test
```

Result: exit 1. The non-E2E checks completed successfully:

- `test:js`: passed.
- `test:css`: passed.
- `test:types`: passed with the existing one CSS warning.
- `test:web`: passed.
- `test:audit`: passed with no known vulnerabilities.
- Server and web builds passed.
- `test:real`: 53 tests, 27 pass, 26 fail, 0 skipped, 0 cancelled.
- All eight new `server/test/yarn.test.ts` tests passed in `test:real`.

The 26 `test:real` failures are the known networked E2E baseline: their stderr contains GitHub's unauthenticated API rate-limit response for IP `5.77.131.74`. This includes the unchanged Yarn Berry and Yarn 1 E2E cases. No unrelated test or infrastructure was modified.

### Diff and scope checks

```sh
git diff --check
git diff --cached --check
```

Both exited 0. Before commit, `git diff --cached --name-only` listed exactly:

```text
server/loader/versions/yarn-identity.ts
server/loader/versions/yarn.ts
server/test/yarn.test.ts
```

## Self-review

- Requirements match: all specified interfaces, branded types, discriminated unions, warning text, and loader behavior are present.
- Identity parsing remains pure and does not log or expose failure reasons.
- The separator finds only the outer coordinate delimiter, so later `@` characters in references do not alter the ident.
- Only `npm:` performs nested alias-target extraction; other structurally valid protocols retain their outer ident.
- Berry locators are authoritative when parseable, while invalid or missing locators fall back only when all descriptors agree on one target.
- Requested names are deduplicated once in insertion order and used for directness.
- Classic `resolved` values affect only git effective-version preservation, not identity.
- Output remains one dependency per valid lock entry in first-seen order; no Task 2 coalescing was introduced.
- No comments, dependencies, `as any`, default exports, or unrelated edits were added.
- No self-review defects were found.

## Commit

```text
f4f309df4f44abea98cec906528207ed83b0497e Fix Yarn lockfile identity parsing
```

## Concerns

- The full suite cannot be green in the current environment because GitHub's unauthenticated API is rate-limited: 26 networked E2E tests failed for that known external reason.
- The first sandboxed full-suite attempt additionally encountered expected restricted-network DNS failure in `pnpm audit`; the approved network rerun passed the audit and exposed the documented GitHub rate-limit baseline.
- `pnpm test:types` retains one unrelated existing CSS warning for `corner-shape`.

## Fix after review

### Finding

`server/loader/versions/yarn.ts` imported the `VersionsLoader` type separately from the `getDirectDependencies` and `separateFiles` values in `./common.ts`, contrary to the repository rule to merge type and regular imports from the same module.

### Change

Merged `VersionsLoader`, `getDirectDependencies`, and `separateFiles` into one import from `./common.ts`. No runtime or product behavior changed.

Diff inspection confirmed that this import merge was the only product change, and `git diff --cached --name-only` listed only `server/loader/versions/yarn.ts` before the amend.

### Format

Command:

```sh
/bin/bash ./scripts/format.sh
```

Result: exit 0.

```text
Finished in 30ms on 1 files using 18 threads.
```

### Focused tests

Command:

```sh
pnpm bnt server/test/yarn.test.ts
```

Result: exit 0, 8 tests run, 8 pass, 0 fail.

```text
✔ loads the grouped Berry issue fixture (2.847667ms)
✔ loads grouped quoted scoped Yarn 1 descriptors (0.156917ms)
✔ uses a Berry locator and alias directness (0.297125ms)
✔ uses a Yarn 1 alias target and alias directness (0.114625ms)
✔ uses locator authority and missing-locator fallback (0.237334ms)
✔ falls back to agreed targets after an unparseable locator (0.16025ms)
✔ preserves an existing git effective version (0.149ms)
✔ warns and excludes unparseable or ambiguous entries (0.296958ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 72.91625
```

### Amended commit

```text
3d57fd389b8bfe6197e6b2cae47ef755ccbda0e6 Fix Yarn lockfile identity parsing
```

This replaces the pre-review commit SHA recorded earlier in this report while retaining the required Task 1 subject and a single Task 1 commit.
