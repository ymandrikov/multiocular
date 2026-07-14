# Task 2 Report: Per-Lockfile Aggregation

## Status

Implemented and committed Task 2 per-lockfile Yarn dependency aggregation for Issue #55.

## Implementation Summary

- Added a local `YarnResolution` type to `server/loader/versions/yarn.ts` using the branded `YarnRequestedName` and `YarnResolvedName` exports from Task 1.
- Added a local `aggregate` function keyed by the serialized `(resolved name, effective version)` tuple.
- Aggregation is performed separately inside each lockfile iteration.
- Equal identities in one lockfile preserve first-occurrence output order and union requested names so any direct alias makes the aggregate direct.
- Distinct effective versions remain separate.
- Equal identities in different lockfiles remain separate and preserve their source paths.
- Added the four required public `yarn.load()` integration tests.

## Files Changed

- `server/loader/versions/yarn.ts`
- `server/test/yarn.test.ts`

No other file was staged or committed. In particular, `server/loader/versions/yarn-identity.ts` was not modified by Task 2.

## TDD Evidence

### RED

After appending all four public integration tests and before changing production code, ran:

```sh
pnpm bnt server/test/yarn.test.ts -t 'coalesces separate Yarn 1 alias and target entries'
```

Result: exit 1, 0 passed, 1 failed.

Relevant output:

```text
✖ coalesces separate Yarn 1 alias and target entries
ℹ tests 1
ℹ pass 0
ℹ fail 1

AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual contained an indirect lodash@4.17.21 dependency
+ actual also contained the expected direct lodash@4.17.21 dependency
```

The failure was the expected duplicate public output from Task 1: actual contained two `lodash@4.17.21` dependencies from the same lockfile, while expected contained one direct aggregate.

### GREEN: focused test

After adding minimal aggregation, ran:

```sh
pnpm bnt server/test/yarn.test.ts -t 'coalesces separate Yarn 1 alias and target entries'
```

Result: exit 0, 1 passed, 0 failed.

```text
✔ coalesces separate Yarn 1 alias and target entries
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### GREEN: all Yarn integration tests

Ran:

```sh
pnpm bnt server/test/yarn.test.ts
```

Result: exit 0, 12 passed, 0 failed.

```text
✔ loads the grouped Berry issue fixture
✔ loads grouped quoted scoped Yarn 1 descriptors
✔ uses a Berry locator and alias directness
✔ uses a Yarn 1 alias target and alias directness
✔ uses locator authority and missing-locator fallback
✔ falls back to agreed targets after an unparseable locator
✔ preserves an existing git effective version
✔ warns and excludes unparseable or ambiguous entries
✔ coalesces separate Yarn 1 alias and target entries
✔ keeps different effective versions separate
✔ coalesces equal identities with different locators
✔ does not aggregate across lockfiles
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

## Required Repository Verification

The required commands were run in order.

### Format

```sh
/bin/bash ./scripts/format.sh
```

Result: exit 0.

```text
Finished in 25ms on 2 files using 18 threads.
```

### Types

```sh
pnpm test:types
```

Result: exit 0, 0 errors and 1 existing CSS warning.

```text
svelte-check found 0 errors and 1 warning in 1 file
```

The warning was `Unknown property: 'corner-shape'` in `web/ui/button.svelte:91:5`.

### Full suite

```sh
pnpm test
```

Result: exit 1 because the sandbox could not resolve the npm registry for `pnpm audit --prod`.

Relevant final output:

```text
test:audit: ENOTFOUND request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
test:audit: Failed
ELIFECYCLE Command failed with exit code 1.
ELIFECYCLE Test failed. See above for more details.
```

Before the audit failure, the visible output showed `test:js` completed, `test:css` completed, both web builds completed, and `test:types` completed with 0 errors and the same single CSS warning. The runner stopped without a final `test:real` pass/fail count, so this run did not produce the brief's expected baseline count of 26 GitHub API rate-limit failures.

An escalated rerun of `pnpm test` was requested to allow npm and GitHub network access. The approval/turn was aborted after 204.1 seconds without a final command result. Per the follow-up instruction, the full suite was not run again.

## Self-Review

- `git diff --check` passed before staging.
- `git diff --cached --check` passed before commit.
- The staged file list contained exactly `server/loader/versions/yarn.ts` and `server/test/yarn.test.ts`.
- The committed diff contains exactly those two files.
- The four new tests are integration tests through `yarn.load()`; there is no direct test of `resolveYarnIdentity` or the local aggregation helper.
- `resolutions` is initialized and aggregated inside the `for (let file of lockFiles)` loop, so aggregation cannot cross lockfile boundaries.
- The key contains only resolved name and effective version; it does not contain source or the constant npm type.
- `Map` insertion order preserves first occurrence.
- Requested-name union preserves directness from aliases and targets.
- Different effective versions remain separate.
- No dependency, lint configuration, `common.ts`, `splitPackage`, or identity-module change was introduced by Task 2.
- No `as any`, default export, or new code comments were added.
- Unrelated dirty and untracked worktree files were preserved and not staged.

## Commit

```text
be4c2db1794ff31ed84c298f039c9bef901c91c0 Coalesce Yarn public dependency identities
```

Commit stat:

```text
server/loader/versions/yarn.ts |  55 +++++++++++++---
server/test/yarn.test.ts       | 142 +++++++++++++++++++++++++++++++++++++++++
2 files changed, 188 insertions(+), 9 deletions(-)
```

## Concerns

- The required full suite could not complete because sandbox DNS blocked the npm audit endpoint. The escalated rerun was interrupted without a result, so no final full-suite test count is available from this Task 2 run.
- No implementation concerns were found in the scoped diff or focused integration verification.
