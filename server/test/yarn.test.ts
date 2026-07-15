import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadedFile } from '../../common/types.ts'
import { yarn } from '../loader/versions/yarn.ts'

test('parses grouped Yarn Berry keys resolving to one version', () => {
  assert.deepEqual(
    yarn.load([
      loadedFile(
        '/project/package.json',
        JSON.stringify({
          dependencies: { 'caniuse-lite': '^1.0.30001702' }
        })
      ),
      loadedFile(
        '/project/yarn.lock',
        [
          '__metadata:',
          '  version: 8',
          '  cacheKey: 10c0',
          '"caniuse-lite@npm:^1.0.30001702, caniuse-lite@npm:^1.0.30001746":',
          '  version: 1.0.30001750',
          '  resolution: "caniuse-lite@npm:1.0.30001750"',
          '  languageName: node',
          '  linkType: hard'
        ].join('\n')
      )
    ]),
    [
      {
        direct: true,
        from: 'yarn',
        name: 'caniuse-lite',
        source: '/project/yarn.lock',
        type: 'npm',
        version: '1.0.30001750'
      }
    ]
  )
})
