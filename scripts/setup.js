#!/usr/bin/env node
// `npm run setup`: nainstaluje whisper.cpp a stáhne model whisperu.
// Options: --model <name> (default: medium), --variant cpu|blas|cuda (Windows),
//          --skip-binary, --skip-model, --force
'use strict';
require('../src/cli')
  .main(['setup', ...process.argv.slice(2)])
  .catch((err) => {
    console.error(`\nInstalace selhala: ${err.message}`);
    process.exit(1);
  });
