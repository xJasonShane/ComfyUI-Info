/// <reference types="vitest" />
import { defineConfig } from 'vite'
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
  },
})
