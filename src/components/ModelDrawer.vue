<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NDrawer } from 'naive-ui'
import { modelStats, store } from '../composables/store'
import Icon from './Icon.vue'
import { useDrawerWidth } from '../composables/ui'
import { dateLocale, t } from '../locales'

const show = defineModel<boolean>('show', { default: false })

const {
  width: drawerWidth,
  dragging: drawerDragging,
  onResizerDown,
  onResizerMove,
  onResizerUp,
} = useDrawerWidth('models', 460)

const maxCount = computed(() => modelStats.value[0]?.count ?? 1)

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(dateLocale())
}

/** 点击模型 → 只看该模型的全部出图（modelFilter 单选筛选，chips 条可一键移除） */
function pick(name: string) {
  store.modelFilter = name
  show.value = false
}
</script>

<template>
  <NDrawer v-model:show="show" :width="drawerWidth" placement="right">
    <div class="drawer-shell" :class="{ resizing: drawerDragging }">
      <div
        class="drawer-resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('app.resizeDrawer')"
        :title="t('app.resizeDrawer')"
        @pointerdown.prevent="onResizerDown"
        @pointermove="onResizerMove"
        @pointerup="onResizerUp"
        @pointercancel="onResizerUp"
      />
      <div class="stats">
        <div class="stats-head">
          <span class="stats-title">{{ t('models.title') }}</span>
          <span class="stats-sub">{{ t('models.sub', { n: modelStats.length }) }}</span>
          <NButton
            size="tiny"
            quaternary
            circle
            :aria-label="t('stats.close')"
            @click="show = false"
          >
            <template #icon><Icon name="x" :size="13" /></template>
          </NButton>
        </div>

        <div v-if="modelStats.length" class="stats-list">
          <button
            v-for="m in modelStats"
            :key="m.name"
            type="button"
            class="stat-row model-row"
            :title="t('models.filterHint', { name: m.name })"
            @click="pick(m.name)"
          >
            <span class="stat-name">{{ m.name }}</span>
            <span class="model-meta">
              <span v-if="m.hash" class="model-hash">{{ m.hash }}</span>
              <span>{{ t('models.lastUsed') }} {{ fmtDay(m.lastUsed) }}</span>
            </span>
            <i class="stat-bar" :style="{ width: `${Math.max(8, (m.count / maxCount) * 100)}%` }" />
            <span class="stat-count">{{ m.count }}</span>
          </button>
        </div>
        <p v-else class="stats-empty">{{ t('models.empty') }}</p>
      </div>
    </div>
  </NDrawer>
</template>
