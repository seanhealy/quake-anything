import js from '@eslint/js';

/**
 * Lint the modular JS that EGO reviews (tsc output under dist/).
 * Run `bun run build` before `bun run lint`.
 */
export default [
    js.configs.recommended,
    {
        files: ['dist/**/*.js'],
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
            // tsc emits class members and top-level declarations back-to-back with
            // no blank lines; `eslint --fix` (run as part of `bun run build`)
            // restores readable spacing, and `bun run lint` fails if it regresses.
            'lines-between-class-members': ['error', 'always'],
            'padding-line-between-statements': ['error', {
                blankLine: 'always',
                prev: ['function', 'class', 'export'],
                next: ['function', 'class', 'export'],
            }],
        },
    },
];
