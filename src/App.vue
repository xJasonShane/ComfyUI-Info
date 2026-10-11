<script lang="ts">
import { defineComponent } from 'vue'
import { useMessage } from 'naive-ui'
import type { MessageApi } from 'naive-ui'

let messageApi: MessageApi | null = null

/**
 * 渲染在 <NMessageProvider> 内部的桥接组件：捕获 message API 供 App 顶层使用。
 * naive-ui 约定 useMessage 只能在 Provider 的子孙组件中调用，
 * 在渲染 Provider 的同一组件里调用会注入失败并中断挂载（页面全黑）。
 */
const MessageBridge = defineComponent({
  setup() {
    messageApi = useMessage()
    return () => null
  },
})

/** 供事件回调取用；仅在组件挂载后才会被触发，messageApi 必已就绪 */
function appMessage(): MessageApi {
  if (!messageApi) throw new Error('NMessageProvider 尚未挂载')
  return messageApi
}
</script>

<script setup lang="ts">
import { computed, ref, watchEffect, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  NButton,
  NConfigProvider,
  NDropdown,
  NMessageProvider,
  NPopconfirm,
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  zhCN,
} from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import TopBar from './components/TopBar.vue'
import ImageCard from './components/ImageCard.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import CompareDrawer from './components/CompareDrawer.vue'
import EmptyState from './components/EmptyState.vue'
import Icon from './components/Icon.vue'
import {
  addFiles,
  favoriteFlags,
  filteredItems,
  parsing,
  rangeIds,
  removeItem,
  removeItems,
  retryAllFailed,
  setItemsFavorite,
  stats,
  store,
  toggleFavorite,
} from './composables/store'
import { exportItems, exportOptions, buildParamsSummary } from './lib/export'
import { copyText, humanBytes } from './lib/utils'
import { statsVisible, randomPickRequest } from './composables/ui'
import { locale, t } from './locales'
import type { ImageItem, IncomingFile } from './types'

/* ---------- 主题 ---------- */
const darkOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#e8a33d',
    primaryColorHover: '#f2b558',
    primaryColorPressed: '#d18f2c',
    primaryColorSuppl: '#e8a33d',
    borderRadius: '8px',
  },
}
const lightOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#b4741f',
    primaryColorHover: '#c98427',
    primaryColorPressed: '#9a621a',
    primaryColorSuppl: '#b4741f',
    borderRadius: '8px',
  },
}
watchEffect(() => {
  document.documentElement.classList.toggle('light', !store.dark)
  document.body.style.background = store.dark ? '#131110' : '#f5f1e9'
})

/* ---------- 画廊虚拟滚动（P3）：按行列窗口渲染，万级列表滚动恒定 DOM 量 ---------- */
// 与 style.css .grid 的 minmax(var(--card-min), 1fr) / gap 13px 保持一致，保证列数计算与实际布局吻合；
// --card-min 由 gallery 元素绑定 store.thumbSize（缩略图大小偏好），列数随之响应式重算
const GRID_GAP = 13
const OVERSCAN_ROWS = 3
const GRID_MIN = computed(() => store.thumbSize)

const galleryRef = ref<HTMLElement | null>(null)
const galleryWidth = ref(0)
/** 画廊顶边滚出视口的像素数（未滚到为负，钳到 0 参与 row 计算） */
const viewTop = ref(0)

const cols = computed(() =>
  Math.max(1, Math.floor((galleryWidth.value + GRID_GAP) / (GRID_MIN.value + GRID_GAP))),
)
const rowH = computed(() => {
  if (!galleryWidth.value) return 0
  const cardW = (galleryWidth.value - GRID_GAP * (cols.value - 1)) / cols.value
  return cardW + GRID_GAP
})
const totalRows = computed(() => Math.ceil(filteredItems.value.length / cols.value))

const startRow = computed(() =>
  Math.max(0, Math.floor(Math.max(0, viewTop.value) / rowH.value) - OVERSCAN_ROWS),
)
const endRow = computed(() =>
  Math.min(
    totalRows.value,
    Math.ceil((Math.max(0, viewTop.value) + window.innerHeight) / rowH.value) + OVERSCAN_ROWS,
  ),
)
// 首帧未量得尺寸时先渲染一小页，量到后立即进入窗口化
const visibleItems = computed(() => {
  if (!rowH.value) return filteredItems.value.slice(0, 24)
  return filteredItems.value.slice(startRow.value * cols.value, endRow.value * cols.value)
})
const topPad = computed(() => startRow.value * rowH.value)
const bottomPad = computed(() => Math.max(0, (totalRows.value - endRow.value) * rowH.value))

// 长列表滚深后提供一键回顶（万级图滚回顶部很痛苦）；viewTop 即画廊顶边滚出的像素
const showBackTop = computed(() => viewTop.value > 600)
function backToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

let scrollRaf = 0
function updateViewTop() {
  const el = galleryRef.value
  if (!el) return
  viewTop.value = -el.getBoundingClientRect().top
}
function onWinScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    updateViewTop()
  })
}
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  updateViewTop()
  window.addEventListener('scroll', onWinScroll, { passive: true })
  window.addEventListener('resize', onWinScroll)
  if (typeof ResizeObserver !== 'undefined' && galleryRef.value) {
    resizeObserver = new ResizeObserver(() => {
      galleryWidth.value = galleryRef.value?.clientWidth ?? 0
      updateViewTop()
    })
    resizeObserver.observe(galleryRef.value)
    galleryWidth.value = galleryRef.value.clientWidth
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onWinScroll)
  window.removeEventListener('resize', onWinScroll)
  resizeObserver?.disconnect()
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})
// 画廊上方的统计行 / 工具栏高度变化会移动画廊顶边，主动校正窗口
watch(
  () => [store.items.length, filteredItems.value.length, store.sourceFilter, store.sortMode],
  () => updateViewTop(),
)

// 被“来源 / 搜索 / 模型”筛选挡住的已解析图片数量（用于空状态引导）
const hiddenCount = computed(() => {
  const shown = new Set(filteredItems.value)
  return store.items.filter((i) => i.status === 'done' && !shown.has(i)).length
})

// 已加载文件的总大小：状态行直观展示本批数据体量（万级扫描时对照内存 / 磁盘心里有数）
const totalBytes = computed(() => store.items.reduce((n, i) => n + i.size, 0))

// 任一筛选偏离默认且确实藏了图时，状态行显示命中数（搜索 / 筛选是否生效一目了然）
const filtersActive = computed(
  () =>
    store.search.trim() !== '' ||
    store.modelFilter !== null ||
    store.sourceFilter !== 'comfyui' ||
    store.dupeOnly ||
    store.favOnly,
)
const showFilteredCount = computed(
  () => filtersActive.value && filteredItems.value.length !== store.items.length,
)
function showAll() {
  store.sourceFilter = 'all'
  store.search = ''
  store.modelFilter = null
}

/* ---------- 标签页标题：多开页签对照时一眼看出规模与筛选命中 ---------- */
const BASE_TITLE = document.title || 'ComfyUI·Info'
watchEffect(() => {
  const total = store.items.length
  if (!total) {
    document.title = BASE_TITLE
    return
  }
  const shown = filteredItems.value.length
  document.title =
    filtersActive.value && shown !== total
      ? `(${shown}/${total}) ${BASE_TITLE}`
      : `(${total}) ${BASE_TITLE}`
})

/* ---------- 详情 ---------- */
const current = ref<ImageItem | null>(null)
const showDetail = ref(false)
function open(item: ImageItem) {
  current.value = item
  showDetail.value = true
}

/** 随机抽一张：从当前筛选结果等概率抽选并打开详情（筛选为空时按钮不出现，这里兜底不动） */
watch(randomPickRequest, () => {
  const list = filteredItems.value
  if (!list.length) return
  open(list[Math.floor(Math.random() * list.length)]!)
})

/** 沿当前筛选顺序切换详情图片（抽屉按钮与键盘 ← / → 共用）；越界不动 */
function navDetail(dir: 1 | -1) {
  if (!current.value) return
  const list = filteredItems.value
  const idx = list.findIndex((i) => i.id === current.value!.id)
  const next = idx + dir
  if (idx < 0 || next < 0 || next >= list.length) return
  current.value = list[next]
}
/** 移除后清场：URL 已随 removeItem 回收，仍打开的抽屉只会渲染裂图残影 */
function closeDetailIfRemoved(gone: ReadonlySet<ImageItem>) {
  if (current.value && gone.has(current.value)) {
    showDetail.value = false
    current.value = null
  }
}

/** 对比 A / B 任一被移除时收起对比抽屉（单张键盘删除不撤详情，仅此抽屉需要） */
function closeCompareIfRemoved(gone: ReadonlySet<ImageItem>) {
  const pair = comparePair.value
  if (pair && (gone.has(pair[0]!) || gone.has(pair[1]!))) {
    showCompare.value = false
    comparePair.value = null
  }
}

// 单张移除；若移除的正是抽屉里打开的这张，一并收起
function onRemove(item: ImageItem) {
  removeItem(item)
  selectedIds.value.delete(item.id)
  const gone = new Set([item])
  closeDetailIfRemoved(gone)
  closeCompareIfRemoved(gone)
}

/**
 * 详情页一键与相邻图片对比：邻居沿当前筛选顺序取（与 ← / → 导航同序），
 * 可用性已在抽屉内按「双方都已解析」置灰，这里兜底校验后打开对比抽屉
 */
function onCompareFromDetail(dir: 1 | -1) {
  if (!current.value) return
  const list = filteredItems.value
  const idx = list.findIndex((i) => i.id === current.value!.id)
  const next = idx + dir
  if (idx < 0 || next < 0 || next >= list.length) return
  const neighbor = list[next]!
  if (neighbor.status !== 'done' || !neighbor.params || !current.value.params) return
  comparePair.value = [current.value, neighbor]
  showCompare.value = true
}

/** 对比抽屉交换 A / B */
function swapCompare() {
  const pair = comparePair.value
  if (pair) comparePair.value = [pair[1]!, pair[0]!]
}

// 批量重试全部解析失败的图片（O4）
function onRetryAll() {
  const n = retryAllFailed()
  if (n) appMessage().success(t('msg.retried', { n }))
  else appMessage().info(t('msg.nothingToRetry'))
}

/* ---------- 多选与批量操作 ---------- */
// 选择独立于筛选：切换筛选后已选条目保持（含当前筛选下不可见的），批量动作按 id 生效
const selectedIds = ref(new Set<string>())
const anchorId = ref<string | null>(null)
const selectedItems = computed(() => store.items.filter((i) => selectedIds.value.has(i.id)))

function toggleSelect(item: ImageItem) {
  if (selectedIds.value.has(item.id)) selectedIds.value.delete(item.id)
  else selectedIds.value.add(item.id)
  anchorId.value = item.id
}

function rangeSelect(item: ImageItem) {
  const list = filteredItems.value
  for (const id of rangeIds(list, anchorId.value, item.id)) selectedIds.value.add(id)
  // 锚点失效（被移除）时重新落点，保证下一次 Shift 点击有有效起点
  if (!anchorId.value || !list.some((i) => i.id === anchorId.value)) anchorId.value = item.id
}

function selectAllFiltered() {
  for (const i of filteredItems.value) selectedIds.value.add(i.id)
}

function clearSelection() {
  selectedIds.value.clear()
  anchorId.value = null
}

function batchRemove() {
  const removed = [...selectedItems.value]
  removeItems(removed)
  clearSelection()
  // 正打开的详情 / 对比图在被移除集合里时收起抽屉，避免裂图残影
  const gone = new Set(removed)
  closeDetailIfRemoved(gone)
  closeCompareIfRemoved(gone)
}

async function batchCopyPrompts() {
  const prompts = selectedItems.value
    .filter((i) => i.status === 'done' && i.params)
    .map((i) => i.params!.positive.join('\n'))
    .filter((s) => s.trim() !== '')
  if (!prompts.length) {
    appMessage().warning(t('msg.noParsedPrompts'))
    return
  }
  const ok = await copyText(prompts.join('\n'))
  if (ok) appMessage().success(t('msg.copiedPrompts', { n: prompts.length }))
  else appMessage().error(t('common.copyFailed'))
}

/** 批量复制 A1111 风格参数摘要：每张图一个块，首行文件名便于区分归属 */
async function batchCopySummaries() {
  const blocks = selectedItems.value
    .filter((i) => i.status === 'done' && i.params)
    .map((i) => `${i.path ?? i.name}\n${buildParamsSummary(i.params!)}`)
    .filter((s) => s.trim() !== '')
  if (!blocks.length) {
    appMessage().warning(t('msg.noParsedParams'))
    return
  }
  const ok = await copyText(blocks.join('\n\n'))
  if (ok) appMessage().success(t('msg.copiedSummaries', { n: blocks.length }))
  else appMessage().error(t('common.copyFailed'))
}

const exporting = ref(false)

async function batchExport(key: string | number) {
  if (parsing.value) {
    appMessage().warning(t('common.exportWhileParsing'))
    return
  }
  exporting.value = true
  try {
    await exportItems(selectedItems.value, key, 'comfyui-info-selected', appMessage())
  } finally {
    exporting.value = false
  }
}

/* ---------- 参数对比（选中恰好 2 张已解析图片） ---------- */
const comparePair = ref<[ImageItem, ImageItem] | null>(null)
const showCompare = ref(false)
const canCompare = computed(
  () =>
    selectedItems.value.length === 2 &&
    selectedItems.value.every((i) => i.status === 'done' && i.params),
)

/* ---------- 批量收藏：选中全部已收藏时切换为「取消收藏选中」 ---------- */
const allSelectedFaved = computed(
  () =>
    selectedItems.value.length > 0 &&
    selectedItems.value.every((i) => favoriteFlags.value.get(i.id) ?? false),
)

function batchSetFavorite() {
  setItemsFavorite(selectedItems.value, !allSelectedFaved.value)
}

function openCompare() {
  const [a, b] = selectedItems.value
  if (!a || !b || !canCompare.value) return
  comparePair.value = [a, b]
  showCompare.value = true
}

/* ---------- 键盘导航（抽屉打开时 ←/→ 沿当前筛选顺序浏览） ---------- */
function onKeydown(e: KeyboardEvent) {
  if (!showDetail.value || !current.value) return
  if (inEditable(e.target)) return // 焦点在输入框内时方向键属于光标，不切换图片
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    navDetail(e.key === 'ArrowRight' ? 1 : -1)
    e.preventDefault()
    return
  }
  // F：收藏 / 取消收藏当前图（与文件行星标按钮同一账本）
  if (e.key.toLowerCase() === 'f') {
    toggleFavorite(current.value)
    e.preventDefault()
    return
  }
  // Delete：移除当前图并同位置补位前进（不绑 Backspace——语义过于接近「返回」，
  // 且移除会连带清掉存档记录，须用明确的按键防误触）
  if (e.key === 'Delete') {
    removeCurrentAndAdvance()
    e.preventDefault()
  }
}

/** 键盘删除当前详情图：按旧筛选顺序同位置补位（下一位顶上，末张退到新的末张），列表空则收抽屉 */
function removeCurrentAndAdvance() {
  const item = current.value
  if (!item) return
  const list = filteredItems.value
  const idx = list.findIndex((i) => i.id === item.id)
  removeItem(item)
  selectedIds.value.delete(item.id)
  const next = idx >= 0 ? (list[idx + 1] ?? list[idx - 1]) : undefined
  if (next) current.value = next
  else {
    showDetail.value = false
    current.value = null
  }
  closeCompareIfRemoved(new Set([item]))
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/* ---------- 全局键盘批量操作：Ctrl/⌘+A 全选筛选结果、Esc 清空选择 ---------- */
function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
}

function onGlobalKeys(e: KeyboardEvent) {
  if (inEditable(e.target)) return
  // Ctrl/⌘+A：全选当前筛选结果（输入框内的原生全选不受影响）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    if (!filteredItems.value.length) return
    e.preventDefault()
    selectAllFiltered()
    return
  }
  // Esc：先清空选择；任一抽屉打开时 Esc 属于关抽屉（NDrawer closeOnEsc），不动选择
  if (
    e.key === 'Escape' &&
    selectedIds.value.size &&
    !showDetail.value &&
    !showCompare.value &&
    !statsVisible.value
  ) {
    e.preventDefault()
    clearSelection()
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeys))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeys))

/* ---------- 剪贴板粘贴添加（FEAT-10）：Ctrl / ⌘+V 直接贴入图片或参数文件 ---------- */
function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files
  if (!files?.length) return
  e.preventDefault()
  const added = addFiles(Array.from(files).map((f) => ({ file: f })))
  if (added) appMessage().success(t('msg.pasted', { n: added }))
}
onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))

// 抽屉关闭后把焦点返还给来源卡片（对话框关闭的 ARIA 模式）
watch(showDetail, (v) => {
  if (!v && current.value) {
    document
      .querySelector<HTMLElement>(`[data-item-id="${current.value.id}"]`)
      ?.focus({ preventScroll: true })
  }
})
// 清空列表时收起详情抽屉，避免展示已撤销 URL 的图片
watch(
  () => store.items.length,
  (len) => {
    if (len === 0) {
      showDetail.value = false
      current.value = null
    }
  },
)

/* ---------- 全窗口拖拽（支持文件夹递归） ---------- */
const dragging = ref(false)
let depth = 0

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return
  depth++
  dragging.value = true
}

function onDragLeave() {
  depth = Math.max(0, depth - 1)
  if (depth === 0) dragging.value = false
}

async function collectDroppedFiles(dt: DataTransfer): Promise<IncomingFile[]> {
  const entries: FileSystemEntry[] = []
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i].webkitGetAsEntry()
    if (entry) entries.push(entry)
  }
  if (!entries.length) return Array.from(dt.files).map((file) => ({ file }))

  const out: IncomingFile[] = []
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      )
      if (file) {
        // fullPath 形如 "/目录/子目录/a.png"，去掉开头的斜杠作为展示与去重用的相对路径
        const path = entry.fullPath.replace(/^\//, '')
        out.push({ file, path: path || undefined })
      }
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        // readEntries 每次最多返回 100 条，必须循环读到空数组
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        )
        if (!batch.length) break
        for (const child of batch) await walk(child)
      }
    }
  }
  for (const e of entries) await walk(e)
  return out
}

async function onDrop(e: DragEvent) {
  depth = 0
  dragging.value = false
  if (!e.dataTransfer) return
  const files = await collectDroppedFiles(e.dataTransfer)
  if (files.length) addFiles(files)
}
</script>

<template>
  <NConfigProvider
    :theme="store.dark ? darkTheme : null"
    :theme-overrides="store.dark ? darkOverrides : lightOverrides"
    :locale="locale === 'en' ? enUS : zhCN"
    :date-locale="locale === 'en' ? dateEnUS : dateZhCN"
  >
    <NMessageProvider>
      <MessageBridge />
      <div
        class="app"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <TopBar />

        <div v-if="store.items.length" class="statline">
          <span
            >{{ t('stat.loaded') }} <b>{{ store.items.length }}</b>
            <span :title="t('stat.totalBytesTitle')">· {{ humanBytes(totalBytes) }}</span></span
          >
          <span
            ><i class="dot" style="background: var(--accent)" /><b>{{ stats.comfyui }}</b>
            {{ t('src.comfyui') }}</span
          >
          <span
            ><i class="dot" style="background: var(--teal)" /><b>{{ stats.a1111 }}</b> A1111</span
          >
          <span
            ><i class="dot" style="background: var(--gray-src)" /><b>{{ stats.none }}</b>
            {{ t('src.none') }}</span
          >
          <span v-if="showFilteredCount" class="stat-filtered">
            {{ t('stat.filtered', { n: filteredItems.length }) }}
          </span>
          <span
            v-if="stats.error"
            class="stat-error"
            role="button"
            tabindex="0"
            :title="t('stat.errorTitle')"
            @click="store.sourceFilter = 'error'"
            @keydown.enter.prevent="store.sourceFilter = 'error'"
            @keydown.space.prevent="store.sourceFilter = 'error'"
          >
            <i class="dot" style="background: var(--danger)" /><b>{{ stats.error }}</b>
            {{ t('src.error') }}
          </span>
          <NButton
            v-if="stats.error"
            size="tiny"
            quaternary
            type="error"
            :title="t('stat.retryAllTitle')"
            @click="onRetryAll"
          >
            {{ t('common.retry') }}
          </NButton>
          <span v-if="parsing" style="color: var(--accent)">{{ t('stat.parsing') }}</span>
        </div>

        <main ref="galleryRef" class="gallery" :style="{ '--card-min': `${store.thumbSize}px` }">
          <template v-if="filteredItems.length">
            <div :style="{ height: topPad + 'px' }" aria-hidden="true" />
            <div class="grid" :class="{ selecting: selectedItems.length > 0 }">
              <ImageCard
                v-for="(it, idx) in visibleItems"
                :key="it.id"
                :item="it"
                :index="idx"
                :selected="selectedIds.has(it.id)"
                @open="open(it)"
                @remove="onRemove(it)"
                @select-toggle="toggleSelect(it)"
                @select-range="rangeSelect(it)"
                @toggle-fav="toggleFavorite(it)"
              />
            </div>
            <div :style="{ height: bottomPad + 'px' }" aria-hidden="true" />
          </template>
          <EmptyState
            v-else
            :filtered="store.items.length > 0"
            :hidden-count="hiddenCount"
            @show-all="showAll"
          />
        </main>

        <div v-if="selectedItems.length" class="select-bar" role="toolbar" aria-label="批量操作">
          <span class="sel-count" v-html="t('bar.selected', { n: selectedItems.length })" />
          <NButton size="tiny" secondary @click="selectAllFiltered">{{
            t('bar.selectAllFiltered')
          }}</NButton>
          <NButton
            v-if="selectedItems.length === 2"
            size="tiny"
            secondary
            :disabled="!canCompare"
            :title="t('bar.compareTitle')"
            @click="openCompare"
          >
            {{ t('bar.compare') }}
          </NButton>
          <NButton size="tiny" secondary @click="batchCopyPrompts">{{
            t('bar.copyPrompts')
          }}</NButton>
          <NButton size="tiny" secondary @click="batchCopySummaries">{{
            t('bar.copySummaries')
          }}</NButton>
          <NButton size="tiny" secondary @click="batchSetFavorite">{{
            allSelectedFaved ? t('bar.unfavSelected') : t('bar.favSelected')
          }}</NButton>
          <NDropdown trigger="click" :options="exportOptions" @select="batchExport">
            <NButton size="tiny" secondary :loading="exporting" :disabled="exporting">{{
              t('bar.exportSelected')
            }}</NButton>
          </NDropdown>
          <NPopconfirm @positive-click="batchRemove">
            <template #trigger>
              <NButton size="tiny" secondary type="error">{{ t('bar.removeSelected') }}</NButton>
            </template>
            {{ t('bar.removeConfirm', { n: selectedItems.length }) }}
          </NPopconfirm>
          <NButton size="tiny" quaternary @click="clearSelection">{{
            t('bar.clearSelection')
          }}</NButton>
        </div>

        <DetailDrawer
          v-model:show="showDetail"
          :item="current"
          @nav="navDetail"
          @compare="onCompareFromDetail"
        />

        <CompareDrawer
          v-model:show="showCompare"
          :a="comparePair?.[0] ?? null"
          :b="comparePair?.[1] ?? null"
          @swap="swapCompare"
        />

        <div v-if="dragging" class="drop-overlay">
          <div class="inner">{{ t('drop.hint') }}</div>
        </div>

        <button
          v-if="showBackTop"
          class="back-top"
          type="button"
          :title="t('app.backTop')"
          :aria-label="t('app.backTop')"
          @click="backToTop"
        >
          <Icon name="arrow-up" :size="17" />
        </button>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
