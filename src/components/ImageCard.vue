<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ImageItem } from '../types'
import { shortModel } from '../lib/utils'
import {
  ensureItemUrl,
  favoriteFlags,
  sameSourceGroups,
  store,
  workflowClusters,
} from '../composables/store'
import { t } from '../locales'
import Icon from './Icon.vue'

const props = defineProps<{ item: ImageItem; index: number; selected?: boolean }>()
const emit = defineEmits<{
  open: []
  remove: []
  'select-toggle': []
  'select-range': []
  'toggle-fav': []
}>()

const broken = ref(false)

// P2：卡片渲染时才创建预览 Blob URL（配合画廊虚拟滚动，只有可见窗口内的条目占内存）
onMounted(() => ensureItemUrl(props.item))

/** F3：聚类排序模式下展示「同工作流第 x/y 张」 */
const cluster = computed(() =>
  store.sortMode === 'workflow' ? workflowClusters.value.get(props.item.id) : undefined,
)

/** F4：同源重复（同工作流同种子）组信息，组内 ≥2 张时展示角标 */
const dupe = computed(() => sameSourceGroups.value.get(props.item.id))

/** 收藏标记：favoriteFlags 全量表按 id 取值 */
const faved = computed(() => favoriteFlags.value.get(props.item.id) ?? false)

/** FEAT-8：URL 未创建前不渲染空 src 的 img（覆盖空占位而非「无法预览」） */
const showImg = computed(
  () => !broken.value && !props.item.detached && !props.item.metaOnly && !!props.item.url,
)

/** Ctrl/⌘+点击或点击指示器切换选中，Shift+点击区间选择，普通点击打开详情 */
function onClick(e: MouseEvent) {
  if (e.shiftKey) {
    e.preventDefault()
    emit('select-range')
    return
  }
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    emit('select-toggle')
    return
  }
  emit('open')
}

const srcColor = computed(() => {
  if (props.item.status === 'error') return 'var(--danger)'
  if (props.item.source === 'comfyui') return 'var(--accent)'
  if (props.item.source === 'a1111') return 'var(--teal)'
  return 'var(--gray-src)'
})

const srcLabel = computed(() => {
  if (props.item.status === 'error') return t('src.error')
  if (props.item.status !== 'done') return t('card.parsing')
  if (props.item.source === 'comfyui') return 'ComfyUI'
  if (props.item.source === 'a1111') return 'A1111'
  return t('src.none')
})

const dims = computed(() => {
  const p = props.item.params
  if (!p?.width || !p?.height) return ''
  const b = p.batch && p.batch > 1 ? `×${p.batch}` : ''
  return `${p.width}×${p.height}${b}`
})

const modelShort = computed(() => {
  const m = props.item.params?.models?.[0]
  return m ? shortModel(m) : ''
})

const displayPath = computed(() => props.item.path ?? props.item.name)
</script>

<template>
  <div
    class="card"
    :class="{ 'card-error': item.status === 'error', 'card-selected': selected }"
    :style="{ '--i': index }"
    role="button"
    tabindex="0"
    :data-item-id="item.id"
    :aria-label="t('card.openAria', { name: item.name })"
    :title="
      item.status === 'error'
        ? t('card.errorTitle', { path: displayPath, error: item.error ?? t('src.error') })
        : displayPath
    "
    @click="onClick"
    @keydown.enter.exact.prevent="$emit('open')"
    @keydown.space.exact.prevent="$emit('open')"
    @keydown.ctrl.space.prevent="$emit('select-toggle')"
    @keydown.meta.space.prevent="$emit('select-toggle')"
  >
    <img v-if="showImg" :src="item.url" loading="lazy" alt="" @error="broken = true" />
    <div v-else-if="item.metaOnly" class="archived">
      <Icon name="file-text" :size="20" :stroke="1.8" />
      <span>{{ t('card.metaFile') }}</span>
      <span class="tip">{{ t('card.metaFileTip') }}</span>
    </div>
    <div v-else-if="item.detached" class="archived">
      <Icon name="image" :size="20" :stroke="1.8" />
      <span>{{ t('card.archived') }}</span>
      <span class="tip">{{ t('card.archivedTip') }}</span>
    </div>
    <div v-else-if="!item.url" class="broken" />
    <div v-else class="broken">{{ t('card.broken') }}</div>
    <div class="src" :style="{ '--src-color': srcColor }"><i />{{ srcLabel }}</div>
    <button
      class="card-check"
      :class="{ on: selected }"
      type="button"
      tabindex="-1"
      :title="selected ? t('card.unselect') : t('card.select')"
      :aria-pressed="!!selected"
      :aria-label="t('card.selectAria')"
      @click.stop.prevent="$emit('select-toggle')"
    />
    <button
      class="card-fav"
      :class="{ on: faved }"
      type="button"
      tabindex="-1"
      :title="faved ? t('card.unfav') : t('card.fav')"
      :aria-pressed="!!faved"
      :aria-label="t('card.favAria')"
      @click.stop.prevent="$emit('toggle-fav')"
    >
      <Icon :name="faved ? 'star-filled' : 'star'" :size="13" />
    </button>
    <button
      class="card-remove"
      type="button"
      :title="t('card.removeTitle')"
      :aria-label="t('card.removeAria')"
      @click.stop="$emit('remove')"
    >
      <Icon name="x" :size="12" :stroke="2.4" />
    </button>
    <div v-if="dupe && dupe.total > 1" class="cluster-badge" :title="t('card.sameSourceTitle')">
      {{ t('card.sameSource', { x: dupe.seq, y: dupe.total }) }}
    </div>
    <div
      v-else-if="cluster && cluster.total > 1"
      class="cluster-badge"
      :title="t('card.sameWorkflowTitle')"
    >
      {{ t('card.sameWorkflow', { x: cluster.seq, y: cluster.total }) }}
    </div>
    <div v-if="modelShort || dims" class="veil">
      <span class="model">{{ modelShort }}</span>
      <span class="dims">{{ dims }}</span>
    </div>
  </div>
</template>
