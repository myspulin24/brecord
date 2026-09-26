#!/usr/bin/env node
// `npm start`: launches Electron with this app. Clears ELECTRON_RUN_AS_NODE,
// which terminals inside Electron-based tools (IDEs, agents) can leak and
// which would otherwise make Electron run as plain Node.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code === null ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
