import { defineConfig } from '@playwright/test'

// E2E 冒烟：对单文件构建产物（dist/index.html）在真实 Chromium 中验证核心链路。
// webServer 每次先重新构建再以 vite preview 提供服务，保证测的永远是最新产物。
export default defineConfig({
  testDir: 'e2e',
  // 用 *.e2e.ts 而非 *.spec.ts：vitest 默认 include 只认 *.test/*.spec，避免单测误捡 e2e
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'zh-CN',
    trace: 'retain-on-failure', // 失败保留 trace，CI 红了可下载排查
  },
  webServer: {
    // CI 已单独构建（E2E_SKIP_BUILD=1）时直接 preview，避免同一流水线构建两次
    command: process.env.E2E_SKIP_BUILD
      ? 'npm run preview -- --port 4173 --strictPort'
      : 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
