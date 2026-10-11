<script setup lang="ts">
/**
 * 搜索区（D3 自 TopBar 迁出）：搜索输入 + 语法速查（hover 与点按双入口，A10）+
 * 搜索历史弹层。三者共享同一套搜索语义与 recentSearches 账本，直接读写全局 store
 * （与项目其他组件一致的单例 store 模式）。
 */
import { computed } from 'vue'
import { NButton, NInput, NPopover } from 'naive-ui'
import Icon from './Icon.vue'
import { clearSearchHistory, recentSearches, store } from '../composables/store'
import { t } from '../locales'

/** 语法速查条目（随界面语言切换重渲染） */
const helpLines = computed(() => [
  t('help.model'),
  t('help.lora'),
  t('help.seed'),
  t('help.seedRange'),
  t('help.numRange'),
  t('help.date'),
  t('help.path'),
  t('help.posneg'),
  t('help.sampler'),
  t('help.vae'),
  t('help.tag'),
  t('help.has'),
  t('help.exclude'),
  t('help.quoted'),
  t('help.and'),
])
</script>

<template>
  <NPopover trigger="hover" placement="bottom-end" :style="{ maxWidth: '300px' }">
    <template #trigger>
      <NInput
        v-model:value="store.search"
        size="small"
        round
        clearable
        :placeholder="t('topbar.searchPlaceholder')"
        style="width: 230px"
      >
        <template #prefix><Icon name="search" :size="14" /></template>
      </NInput>
    </template>
    <div class="search-help">
      <b>{{ t('help.title') }}</b>
      <p v-for="line in helpLines" :key="line" v-html="line" />
    </div>
  </NPopover>

  <!-- 语法速查的触屏 / 键盘入口（A10）：hover 弹层只有指针设备可达，这里补一个点按按钮 -->
  <NPopover trigger="click" placement="bottom-end" :style="{ maxWidth: '300px' }">
    <template #trigger>
      <NButton
        size="small"
        quaternary
        circle
        :aria-label="t('help.title')"
        :title="t('help.title')"
      >
        <template #icon><Icon name="help-circle" :size="15" /></template>
      </NButton>
    </template>
    <div class="search-help">
      <b>{{ t('help.title') }}</b>
      <p v-for="line in helpLines" :key="line" v-html="line" />
    </div>
  </NPopover>

  <NPopover v-if="recentSearches.length" trigger="click" placement="bottom-start">
    <template #trigger>
      <NButton
        size="small"
        quaternary
        circle
        :aria-label="t('topbar.searchHistory')"
        :title="t('topbar.searchHistory')"
      >
        <template #icon><Icon name="history" :size="15" /></template>
      </NButton>
    </template>
    <div class="search-history">
      <div class="sh-head">
        <b>{{ t('topbar.searchHistory') }}</b>
        <button type="button" class="sh-clear" @click="clearSearchHistory">
          {{ t('topbar.searchHistoryClear') }}
        </button>
      </div>
      <button
        v-for="(q, i) in recentSearches"
        :key="`${q}-${i}`"
        type="button"
        class="sh-item"
        :title="q"
        @click="store.search = q"
      >
        <Icon name="search" :size="12" :stroke="2.2" />
        <span>{{ q }}</span>
      </button>
    </div>
  </NPopover>
</template>
