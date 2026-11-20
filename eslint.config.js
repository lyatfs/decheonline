import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Determinism: the sim must give identical results on every JS engine, in every
// run. Math.sqrt is allowed: IEEE 754 requires it correctly rounded, like + - * /
// (sim code wraps it as sqrt32, docs/spec/core.md §3).
const transcendentalMath = [
  'random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10',
  'pow', 'cbrt', 'hypot',
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', 'assets-local/', '**/test-results/', '**/playwright-report/', 'tools/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js', 'apps/server/**', 'e2e/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/client/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['packages/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...transcendentalMath.map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} is not deterministic across engines or runs; forbidden in packages/sim.`,
        })),
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Date is wall-clock time; forbidden in packages/sim.' },
      ],
    },
  },
);
