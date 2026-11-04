/**
 * ESLint flat config for the poster scripts.
 *
 * The `@notmike101/eslint-config-*` packages are private (never published); the tarballs
 * under `vendor/eslint-configs/` are artifacts of a green "CI and package archives" run of
 * notmike101/eslint-configs (see README). Their generic entries carry no `files` key, so
 * they apply repo-wide by default.
 */
import jsConfig from '@notmike101/eslint-config-js';
import jsdocConfig from '@notmike101/eslint-config-jsdoc';
import globals from 'globals';

export default [
    {
        /* tmp/bundle.js + worker chunks = vendored site/runtime JS pulled for truth
           forensics 11-04 (856KB minified); harness .mjs scripts in tmp/ stay linted */
        ignores: ['vendor/**', 'node_modules/**', 'tmp/bundle.js', 'tmp/import-worker-*.js', 'tmp/source-love-command-worker-*.js', 'tmp/importer_worker.js'],
    },
    ...jsConfig,
    ...jsdocConfig,
    {
        files: ['**/*.{js,mjs}'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            'import/order': 'off',
            /* Every email-poll and keystroke step awaits in sequence BY DESIGN: polling must
               run one request at a time, and typing simulates real-time sleeps per keypress. */
            'no-await-in-loop': 'off',
            // CJS requires; import resolution adds nothing here.
            'import/no-unresolved': 'off',
            // Scripts talk to the console on purpose; it is their entire UI.
            'no-console': 'off',
        },
    },
];
