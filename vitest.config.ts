import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      // Lets the build/prompt pipeline be tested without a running Electron app.
      electron: resolve('src/test/electron-stub.ts')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
