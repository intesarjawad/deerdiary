import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    pool: 'forks',
    env: { TZ: 'America/New_York' },
  },
});
