// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import vitest from 'eslint-plugin-vitest';
import prettier from 'eslint-plugin-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  // Base configuration
  {
    plugins: {
      vitest,
      prettier,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      ...eslint.configs.recommended.rules,
      'prettier/prettier': ['error', { singleQuote: true, printWidth: 100 }],
    },
    languageOptions: {
      globals: {
        node: true,
      },
    },
  },
  ...tseslint.configs.recommended,
  // JavaScript file overrides
  {
    files: ['**/*.js'],
    rules: {
      '@typescript-eslint/no-var-requires': 0,
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  // TypeScript file overrides
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'vitest/expect-expect': 'off',
    },
  },
);
