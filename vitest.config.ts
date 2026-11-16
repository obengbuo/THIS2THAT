import { defineConfig } from 'vitest/config';
import path from 'node:path';

const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      { find: '@ftt/game-engine/board', replacement: r('packages/game-engine/src/board.ts') },
      { find: '@ftt/game-engine', replacement: r('packages/game-engine/src/index.ts') },
      { find: '@ftt/dictionary', replacement: r('packages/dictionary/src/index.ts') },
      { find: '@ftt/shared-types', replacement: r('packages/shared-types/src/index.ts') },
      { find: '@ftt/api', replacement: r('apps/api/src/index.ts') },
    ],
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120_000 },
});
