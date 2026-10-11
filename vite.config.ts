import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  plugins: [vue(), viteSingleFile()],
  build: {
    chunkSizeWarningLimit: 4096,
  },
  test: {
    setupFiles: ['./tests/setup.ts'],
    // 默认 node 环境（lib / store 单测）；组件测试文件以
    // `// @vitest-environment happy-dom` 文件头声明 DOM 环境（E3）
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/composables/**'],
      // E3：门禁只守纯函数核心（src/lib），阈值略低于当前水位作棘轮——
      // 新增解析 / 数据层代码须带测试，或显式上调阈值并说明理由
      thresholds: {
        'src/lib/**': { statements: 82, branches: 73, functions: 80, lines: 85 },
      },
    },
  },
})
