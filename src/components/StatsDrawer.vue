<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NDrawer } from 'naive-ui'
import { store, usageStats } from '../composables/store'
import type { UsageStat } from '../composables/store'
import Icon from './Icon.vue'

const show = defineModel<boolean>('show', { default: false })

const narrowQuery = window.matchMedia('(max-width: 959.98px)')
const isNarrow = ref(narrowQuery.matches)
const onNarrowChange = (e: MediaQueryListEvent) => {
  isNarrow.value = e.matches
}
onMounted(() => narrowQuery.addEventListener('change', onNarrowChange))
onBeforeUnmount(() => narrowQuery.removeEventListener('change', onNarrowChange))
const drawerWidth = computed(() => (isNarrow.value ? '100%' : 560))

interface StatSection {
  title: string
  kind: 'model' | 'lora' | 'sampler'
  list: UsageStat[]
}

const sections = computed<StatSection[]>(() => [
  { title: '模型', kind: 'model', list: usageStats.value.models },
  { title: 'LoRA', kind: 'lora', list: usageStats.value.loras },
  { title: '采样器', kind: 'sampler', list: usageStats.value.samplers },
])
const hasAny = computed(() => sections.value.some((s) => s.list.length > 0))

const maxCount = (list: UsageStat[]): number => list[0]?.count ?? 1

/**
 * 点击统计项 → 应用对应筛选并关闭抽屉。模型走 modelFilter 精确筛选；
 * LoRA / 采样器写入搜索框：含空格的名称会被 parseQuery 拆成多词 AND，
 * 而搜索串（searchText）包含完整名称，逐词命中等价于整名命中。
 */
function pick(kind: StatSection['kind'], name: string) {
  if (kind === 'model') store.modelFilter = name
  else store.search = name
  show.value = false
}
</script>

<template>
  <NDrawer v-model:show="show" :width="drawerWidth" placement="right">
    <div class="stats">
      <div class="stats-head">
        <span class="stats-title">生成统计</span>
        <span class="stats-sub">按已解析图片聚合使用频次，点击条目可直接筛选</span>
        <NButton size="tiny" quaternary circle aria-label="关闭统计" @click="show = false">
          <template #icon><Icon name="x" :size="13" /></template>
        </NButton>
      </div>

      <template v-if="hasAny">
        <section v-for="sec in sections" :key="sec.kind" class="stats-section">
          <div class="stats-section-title">{{ sec.title }}（{{ sec.list.length }}）</div>
          <div v-if="sec.list.length" class="stats-list">
            <button
              v-for="s in sec.list"
              :key="s.name"
              type="button"
              class="stat-row"
              :title="`筛选${sec.title}「${s.name}」`"
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
          <p v-else class="stats-empty">暂无数据</p>
        </section>
      </template>
      <p v-else class="stats-empty">还没有已解析出参数的图片——先添加一些图片，再来看统计。</p>
    </div>
  </NDrawer>
</template>
