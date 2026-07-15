import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import type {
  DependencyName,
  DependencyVersion,
  FilePath
} from '../../common/types.ts'
import { deleteTemporary, getNpmContent } from '../loader/npm.ts'

let shimDir: string | undefined
let originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  deleteTemporary()
  if (shimDir) {
    await rm(shimDir, { force: true, recursive: true })
    shimDir = undefined
  }
})

async function forbidAbsolutePathsInTar(): Promise<void> {
  let real = execSync('command -v tar').toString().trim()
  shimDir = await mkdtemp(join(tmpdir(), 'multiocular-shim-'))
  let shim = join(shimDir, 'tar')
  await writeFile(
    shim,
    '#!/bin/sh\n' +
      'for arg in "$@"; do\n' +
      '  case "$arg" in\n' +
      '    /*)\n' +
      '      echo "tar: absolute path $arg is not portable" >&2\n' +
      '      exit 128\n' +
      '      ;;\n' +
      '  esac\n' +
      'done\n' +
      `exec "${real}" "$@"\n`
  )
  await chmod(shim, 0o755)
  process.env.PATH = `${shimDir}:${originalPath}`
}

async function makeTarFail(): Promise<void> {
  shimDir = await mkdtemp(join(tmpdir(), 'multiocular-shim-'))
  let shim = join(shimDir, 'tar')
  await writeFile(
    shim,
    '#!/bin/sh\necho "tar: simulated extraction failure" >&2\nexit 1\n'
  )
  await chmod(shim, 0o755)
  process.env.PATH = `${shimDir}:${originalPath}`
}

test(
  'extracts tarballs without absolute paths in tar arguments',
  { skip: process.platform === 'win32' },
  async () => {
    await forbidAbsolutePathsInTar()
    let dir = await getNpmContent(
      '.' as FilePath,
      'nanoid' as DependencyName,
      '5.1.5' as DependencyVersion
    )
    match(await readFile(join(dir, 'package.json'), 'utf8'), /"name": "nanoid"/)
    equal(existsSync(join(dir, 'package.tgz')), false)
  }
)

test(
  'removes temporary directory when tar extraction fails',
  { skip: process.platform === 'win32' },
  async () => {
    await makeTarFail()
    let before = await readdir(tmpdir())
    await rejects(
      getNpmContent(
        '.' as FilePath,
        'nanoid' as DependencyName,
        '5.1.5' as DependencyVersion
      )
    )
    let after = await readdir(tmpdir())
    let leaked = after.filter(
      name => name.startsWith('multiocular-') && !before.includes(name)
    )
    deepEqual(leaked, [])
  }
)
