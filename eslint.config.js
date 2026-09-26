'use strict';
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off', // ANSI escapes are stripped on purpose
  eqeqeq: ['error', 'always', { null: 'ignore' }], // `x == null` means null or undefined
  'prefer-const': 'error',
  'no-var': 'error',
};

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'smoke-output/**'] },
  js.configs.recommended,
  // Main process, core, CLI, scripts, tests: Node (CommonJS).
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } }, rules },
  // Renderer pages: classic scripts. icons.js and logo.js define globals that
  // app.js (loaded after them) uses.
  {
    files: ['src/ui/**/*.js', 'src/recorder/recorder.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['src/ui/app.js'],
    languageOptions: { globals: { icon: 'readonly', hydrateIcons: 'readonly', LOGO_SVG: 'readonly' } },
  },
  {
    files: ['src/recorder/recorder-worklet.js'],
    languageOptions: { sourceType: 'script', globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' } },
  },
];
