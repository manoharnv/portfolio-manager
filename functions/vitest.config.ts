import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // No network, no real Firestore/FCM in unit tests: handlers are pure
    // functions over injected fakes (docs/00 §0.5).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test-utils.ts',
        'src/test-utils/**',
        'src/index.ts',
        // Thin, untested Firebase Admin SDK wiring (docs/00 §0.5) — everything
        // with actual logic is tested against src/test-utils/fakes.ts instead.
        'src/adapters/**',
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
