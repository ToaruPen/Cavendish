import eslint from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Base configs ──────────────────────────────────────────
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended as tseslint.ConfigArray,

  // ── Global ignores ────────────────────────────────────────
  {
    ignores: ['dist/', 'node_modules/', '*.config.ts'],
  },

  // ── TypeScript type-aware linting ─────────────────────────
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Import plugin ─────────────────────────────────────────
  {
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: './tsconfig.json',
        }),
      ],
    },
    rules: {
      // Import ordering
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
    },
  },

  // ── Core rules ────────────────────────────────────────────
  {
    rules: {
      // ─ Must-have (ESLint core) ─
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-debugger': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],

      // ─ Must-have (TS extensions override base rules) ─
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      'no-new-func': 'error',

      // ─ Strict TS rules (already in strictTypeChecked, reinforced here) ─
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],

      // ─ Additional safety ─
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
    },
  },
);
