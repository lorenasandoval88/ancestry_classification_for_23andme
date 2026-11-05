#!/usr/bin/env node
'use strict';
// One entry point; preparation uses Node and model fitting uses Python.
const {spawn} = require('node:child_process');
const path = require('node:path');
let args = process.argv.slice(2);
if (!args.length) args = ['train'];
const child = spawn('python', [path.join(__dirname, 'pipeline.py'), ...args],
  {stdio: 'inherit', shell: false});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('exit', (code, signal) => {process.exitCode = code ?? (signal ? 130 : 1);});
