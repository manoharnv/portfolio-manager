// Extends the shared workspace config (docs/00 §0.3) and adds the three things
// an Expo app needs that a Node library does not:
//   - React Native / Jest globals for the app sources,
//   - a CommonJS island for the Metro / Babel / Jest config files,
//   - `no-console` relaxed to warn/error, since the app has no pino logger.
//
// `.mjs` (not `.js`) because this package is CommonJS for Metro/Babel/Jest's
// sake — see README "Divergences from docs/00".
import baseConfig from '../../eslint.config.js';

const RN_GLOBALS = {
  __DEV__: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.expo/**',
      'android/**',
      'ios/**',
      'expo-env.d.ts',
    ],
  },
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { globals: RN_GLOBALS },
    rules: {
      // docs/00 §0.7.5 bans `console` in *library* code. The app has no pino;
      // `src/lib/log.ts` is the single wrapper and only ever emits warn/error.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'jest.setup.js'],
    languageOptions: {
      globals: {
        ...RN_GLOBALS,
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        global: 'writable',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Metro, Babel and Jest all load their config with `require`, so these
    // files are CommonJS by necessity — see README "Divergences from docs/00".
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        jest: 'readonly',
        global: 'writable',
        beforeEach: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
