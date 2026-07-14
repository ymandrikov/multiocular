# Final verification

Run from `/Users/ym/work/repos/multiocular` on `be4c2db1794ff31ed84c298f039c9bef901c91c0`.

1. `/bin/bash ./scripts/format.sh` exited 0. The explicit interpreter was required because `/usr/bin/bash` from the script shebang does not exist on this host.
2. `pnpm test:types` exited 0 with 0 errors and the existing `corner-shape` CSS warning in `web/ui/button.svelte`.
3. `pnpm test` ran with network access and exited 0. `test:js`, `test:css`, `test:types`, `test:audit`, `test:web`, server/web builds, and `test:real` passed. `test:real` reported 57 tests, 57 pass, 0 fail, including all 12 tests in `server/test/yarn.test.ts` and the unchanged Yarn 1/Berry end-to-end suites.
4. `git diff --check 81ae319bd4c91340e25c3e48b5a7b1bb3c5d773c..be4c2db1794ff31ed84c298f039c9bef901c91c0` exited 0.
