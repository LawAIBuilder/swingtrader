import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname
});

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: [
    '.next/**',
    'node_modules/**',
    'dist/**',
    'coverage/**',
    'next-env.d.ts',
    'src/types/database.generated.ts'
    ]
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Underscore-prefixed names are intentional placeholders — the convention
      // here mirrors interface signatures (e.g. DisabledBrokerClient mirrors
      // BrokerClient) where the parameter is intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  }
];

export default config;
