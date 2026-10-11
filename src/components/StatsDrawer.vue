<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NDrawer } from 'naive-ui'
import {
  dailyCounts,
  dirStats,
  keywordStats,
  resolutionStats,
  store,
  usageStats,
} from '../composables/store'
import type { UsageStat } from '../composables/store'
import Icon from './Icon.vue'
import { useDrawerWidth } from '../composables/ui'
import { buildStatsCsv } from '../lib/export'
import { downloadText } from '../lib/utils'
import { t } from '../locales'

const show = defineModel<boolean>('show', { default: false })

const drawerWidth = useDrawerWidth(560)

interface StatSection {
  title: string
  kind: 'model' | 'lora' | 'sampler' | 'day' | 'keyword' | 'dir' | 'res'
  list: UsageStat[]
}

const sections = computed<StatSection[]>(() => [
  { title: t('stats.models'), kind: 'model', list: usageStats.value.models },
  { title: t('stats.loras'), kind: 'lora', list: usageStats.value.loras },
  { title: t('stats.samplers'), kind: 'sampler', list: usageStats.value.samplers },
  {
    title: t('stats.trend'),
    kind: 'day',
    list: dailyCounts.value.map((d) => ({ name: d.day, count: d.count })),
  },
  { title: t('stats.dirs'), kind: 'dir', list: dirStats.value },
  { title: t('stats.resolutions'), kind: 'res', list: resolutionStats.value },
  { title: t('stats.keywords'), kind: 'keyword', list: keywordStats.value },
])
const hasAny = computed(() => sections.value.some((s) => s.list.length > 0))
const statsExporting = ref(false)

const maxCount = (list: UsageStat[]): number => list[0]?.count ?? 1

/**
 * 点击统计项 → 应用对应筛选并关闭抽屉。模型走 modelFilter 精确筛选；
 * 目录写入 `path:"…"`、LoRA / 采样器写入 `lora:"…"` / `sampler:"…"`
 * （定向字段 + 引号：含空格的名称整体成词，不与提示词等其他搜索域串词）；
 * 分辨率拆成 `w:W h:H` 两个数值条件（parseQuery 无操作符为精确相等）；
 * 高频词保持裸关键词（其语义就是「提示词里出现过」）；日期行写入 `date:`
 * 条件（本地时区按天匹配 mtime，见 store 的 hitDate）。
 */
function pick(kind: StatSection['kind'], name: string) {
  if (kind === 'model') store.modelFilter = name
  else if (kind === 'dir') store.search = `path:"${name}"`
  else if (kind === 'lora') store.search = `lora:"${name}"`
  else if (kind === 'sampler') store.search = `sampler:"${name}"`
  else if (kind === 'res') {
    const [w, h] = name.split('×')
    store.search = `w:${w} h:${h}`
  } else store.search = kind === 'day' ? `date:${name}` : name
  show.value = false
}

async function exportStats() {
  statsExporting.value = true
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(
      `comfyui-info-stats-${stamp}.csv`,
      buildStatsCsv(sections.value.map(({ title, list }) => ({ title, rows: list }))),
      'text/csv',
    )
  } finally {
    statsExporting.value = false
  }
}
</script>

<template>
  <NDrawer v-model:show="show" :width="drawerWidth" placement="right">
    <div class="stats">
      <div class="stats-head">
        <span class="stats-title">{{ t('stats.title') }}</span>
        <span class="stats-sub">{{ t('stats.sub') }}</span>
        <NButton
          size="tiny"
          secondary
          :loading="statsExporting"
          :title="t('stats.exportTitle')"
          @click="exportStats"
        >
          {{ t('stats.exportCsv') }}
        </NButton>
        <NButton size="tiny" quaternary circle :aria-label="t('stats.close')" @click="show = false">
          <template #icon><Icon name="x" :size="13" /></template>
        </NButton>
      </div>

      <template v-if="hasAny">
        <section v-for="sec in sections" :key="sec.kind" class="stats-section">
          <div class="stats-section-title">{{ sec.title }} ({{ sec.list.length }})</div>
          <div v-if="sec.list.length" class="stats-list">
            <button
              v-for="s in sec.list"
              :key="s.name"
              type="button"
              class="stat-row"
              :title="t('stats.filterHint', { title: sec.title, name: s.name })"
              @click="pick(sec.kind, s.name)"
            >
              <span class="stat-name">{{ s.name }}</span>
              <i
                class="stat-bar"
                :style="{ width: `${Math.max(8, (s.count / maxCount(sec.list)) * 100)}%` }"
              />
              <span class="stat-count">{{ s.count }}</span>
            </button>
          </div>
          <p v-else class="stats-empty">{{ t('stats.emptySection') }}</p>
        </section>
      </template>
      <p v-else class="stats-empty">{{ t('stats.empty') }}</p>
    </div>
  </NDrawer>
</template>
