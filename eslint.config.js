// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'bench/', 'scripts/', 'src/__tests__/', '*.config.js', '*.config.mjs', '*.config.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        // Default: camelCase, no leading/trailing underscore
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        // Variables: camelCase OR UPPER_CASE (for module-level constants)
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        // Parameters: camelCase, allow leading underscore for intentionally unused
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'forbid',
        },
        // Types & classes: PascalCase
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        // Private members: camelCase, NO underscore prefix (use `private` keyword)
        {
          selector: 'memberLike',
          modifiers: ['private'],
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        // Enum members: SCREAMING_SNAKE_CASE
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        // Property names: allow camelCase + UPPER_CASE (for LIMITS.MAX_KEY_LENGTH etc.)
        // AND allow the documented `_sync` discriminant field (public API contract).
        {
          selector: 'property',
          format: ['camelCase', 'UPPER_CASE', 'snake_case'],
          leadingUnderscore: 'allow',
          filter: {
            regex: '^(_sync|_data|_eventsCount|_map|__proto__|__inflight__|__tenant__|proto|inflight|tenant|cache|dedupe)$|^[A-Z][A-Z0-9_]+$',
            match: true,
          },
        },
        // Type property names: same exception list
        {
          selector: 'typeProperty',
          format: ['camelCase', 'UPPER_CASE', 'snake_case'],
          leadingUnderscore: 'allow',
          filter: {
            regex: '^(_sync|_data|_eventsCount|_map|__proto__|__inflight__|__tenant__|proto|inflight|tenant|cache|dedupe)$|^[A-Z][A-Z0-9_]+$',
            match: true,
          },
        },
        // Object literal properties: allow underscore-prefixed for mock fixtures + UPPER_CASE
        {
          selector: 'objectLiteralProperty',
          format: ['camelCase', 'UPPER_CASE', 'snake_case'],
          leadingUnderscore: 'allow',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-unused-expressions': 'error',
    },
  },
  // Tests: same rules but relaxed unused-vars (test imports often exist for type side-effects)
  {
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-expressions': 'off',
    },
  },
)
