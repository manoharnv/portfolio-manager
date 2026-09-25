// Jest, not vitest — `jest-expo` is the only preset that understands Metro's
// resolver, the Expo module registry and the RN transform pipeline. Documented
// as a deliberate divergence from docs/00 §0.5 in README.md.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.expo/'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'app/**/*.tsx',
    '!src/**/*.test.{ts,tsx}',
    '!src/test-utils.tsx',
    '!src/theme.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      statements: 80,
      functions: 80,
      branches: 75,
    },
  },
  clearMocks: true,
  resetMocks: false,
};
