import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'tests/fixtures/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: { ...globals.browser },
    },
  },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: {
      // TS 编译器（vue-tsc）负责未定义标识符检查，no-undef 读不到类型只会误报
      'no-undef': 'off',
    },
  },
  {
    rules: {
      // 解析器中带注释的空 catch 是有意为之：单个损坏块不影响其余块
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 单词组件名为项目约定：App 是根组件，Icon 是通用图标壳
      'vue/multi-word-component-names': ['error', { ignores: ['App', 'Icon'] }],
    },
  },
)
