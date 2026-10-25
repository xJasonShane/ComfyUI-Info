<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ImageItem } from '../types'
import { shortModel } from '../lib/utils'
import {
  ensureItemThumb,
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

// P2：卡片渲染时才创建预览 Blob URL（配合画廊虚拟滚动，只有可见窗口内的条目占内存）；
// F2：存档卡片同时惰性取回缩略图（base64 → objectURL），无原文件也能预览
onMounted(() => {
  ensureItemUrl(props.item)
  if (props.item.detached) void ensureItemThumb(props.item)
  // 任何滚动都收起预览：虚拟滚动 / 抽屉滚动会让固定定位的预览指向错误的卡片
  window.addEventListener('scroll', hidePreview, { passive: true, capture: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', hidePreview, { capture: true })
  hidePreview()
})

/** F3：聚类排序模式下展示「同工作流第 x/y 张」 */
const cluster = computed(() =>
  store.sortMode === 'workflow' ? workflowClusters.value.get(props.item.id) : undefined,
)

/** F4：同源重复（同工作流同种子）组信息，组内 ≥2 张时展示角标 */
const dupe = computed(() => sameSourceGroups.value.get(props.item.id))

/** 收藏标记：favoriteFlags 全量表按 id 取值 */
const faved = computed(() => favoriteFlags.value.get(props.item.id) ?? false)

/** FEAT-8：URL 未创建前不渲染空 src 的 img（覆盖空占位而非「无法预览」）；
 * F2：存档项无文件 URL 时以内嵌缩略图兜底 */
const showImg = computed(
  () => !broken.value && !props.item.metaOnly && !!(props.item.url || props.item.thumb),
)

const imgSrc = computed(() => props.item.url || props.item.thumb)

/* ---------- G1：悬停快速预览 ---------- */
// 卡片是 1:1 裁切构图，看原比例要逐张开详情——悬停停顿 350ms 后在卡片旁
// 浮出未裁切的大图（pointer-events:none 纯展示）。安全模式不弹（防走光语义优先）。
const cardEl = ref<HTMLElement | null>(null)
const previewPos = ref<{ x: number; y: number } | null>(null)
let previewTimer = 0

function hidePreview() {
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = 0
  }
  previewPos.value = null
}

function onCardEnter() {
  hidePreview()
  if (store.safeMode || props.item.metaOnly || props.item.status === 'error') return
  if (!props.item.url && !props.item.thumb) return
  previewTimer = window.setTimeout(() => {
    previewTimer = 0
    const rect = cardEl.value?.getBoundingClientRect()
    if (!rect) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 优先卡片右侧，空间不足放左侧；纵向钳在视口上部（预览最高 60vh）
    const w = Math.min(420, vw * 0.38)
    const x = rect.right + 12 + w <= vw ? rect.right + 12 : Math.max(8, rect.left - 12 - w)
    const y = Math.max(8, Math.min(rect.top, vh * 0.4))
    previewPos.value = { x, y }
  }, 350)
}

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
  if (props.item.source === 'fooocus') return 'var(--violet)'
  return 'var(--gray-src)'
})

const srcLabel = computed(() => {
  if (props.item.status === 'error') return t('src.error')
  if (props.item.status !== 'done') return t('card.parsing')
  if (props.item.source === 'comfyui') return 'ComfyUI'
  if (props.item.source === 'a1111') return 'A1111'
  if (props.item.source === 'fooocus') return 'Fooocus'
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
    ref="cardEl"
    class="card"
    :class="{
      'card-error': item.status === 'error',
      'card-selected': selected,
      safe: store.safeMode,
    }"
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
    @mouseenter="onCardEnter"
    @mouseleave="hidePreview"
    @keydown.enter.exact.prevent="$emit('open')"
    @keydown.space.exact.prevent="$emit('open')"
    @keydown.ctrl.space.prevent="$emit('select-toggle')"
    @keydown.meta.space.prevent="$emit('select-toggle')"
  >
    <img v-if="showImg" :src="imgSrc" loading="lazy" alt="" @error="broken = true" />
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
      @keydown.stop
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
      @keydown.stop
      @click.stop.prevent="$emit('toggle-fav')"
    >
      <Icon :name="faved ? 'star-filled' : 'star'" :size="13" />
    </button>
    <button
      class="card-remove"
      type="button"
      :title="t('card.removeTitle')"
      :aria-label="t('card.removeAria')"
      @keydown.stop
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
    <!-- G1：悬停快速预览。Teleport 到 body：卡片入场动画的 transform 会让 fixed 定位
         相对卡片而非视口，Portal 出去才拿得到真实视口坐标 -->
    <Teleport to="body">
      <img
        v-if="previewPos"
        class="card-quick-preview"
        :src="imgSrc"
        :style="{ left: `${previewPos.x}px`, top: `${previewPos.y}px` }"
        alt=""
      />
    </Teleport>
  </div>
</template>
