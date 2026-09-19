import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
