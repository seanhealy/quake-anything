import js from '@eslint/js';

/**
 * Lint the packed JS that EGO reviews (bun build output).
 * Run `bun run build` before `bun run lint`.
 */
export default [
    js.configs.recommended,
    {
        files: ['extension.js', 'prefs.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                global: 'readonly',
                imports: 'readonly',
                ARGV: 'readonly',
                pkg: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-empty': ['error', {allowEmptyCatch: true}],
        },
    },
];
