#!/usr/bin/env node
// Node strips the types on import (default since 22.18). Nothing is compiled.
import { main } from '../src/cli.ts'

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
