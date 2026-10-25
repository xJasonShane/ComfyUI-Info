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
  NAutoComplete,
  NButton,
  NConfigProvider,
  NDropdown,
  NMessageProvider,
  NModal,
  NPopconfirm,
  NPopover,
  darkTheme,
  dateEnUS,
  dateZhCN,
  enUS,
  zhCN,
} from 'naive-ui'
import TopBar from './components/TopBar.vue'
import ImageCard from './components/ImageCard.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import CompareDrawer from './components/CompareDrawer.vue'
import EmptyState from './components/EmptyState.vue'
import Icon from './components/Icon.vue'
import {
  addFiles,
  dismissUndo,
  favoriteFlags,
  filteredItems,
  keepLatestOfDupes,
  parsing,
  rangeIds,
  removeItemUndoable,
  removeItemsUndoable,
  retryAllFailed,
  setItemsFavorite,
  setItemsTag,
  stats,
  store,
  tagCounts,
  toggleFavorite,
  undoLastRemoval,
  undoState,
  removeQueryToken,
  tokenizeQuery,
  type SourceFilter,
} from './composables/store'
import { exportItems, exportOptions, buildParamsSummary } from './lib/export'
import { copyText, humanBytes } from './lib/utils'
import { applyThemeVariables, themeOverrides } from './theme'
import { modelsVisible, randomPickRequest, shortcutsVisible, statsVisible } from './composables/ui'
import { useVirtualGrid } from './composables/useVirtualGrid'
import { locale, t } from './locales'
import type { ImageItem, IncomingFile } from './types'

/* ---------- 主题（D5：色值单一来源在 theme.ts，同时驱动 naive 与 CSS 变量） ---------- */
const themeOv = computed(() => themeOverrides(store.dark))
watchEffect(() => {
  document.documentElement.classList.toggle('light', !store.dark)
  applyThemeVariables(store.dark)
})

/* ---------- 画廊虚拟滚动（P3 / D3）：实现整体在 composables/useVirtualGrid.ts ---------- */
const {
  galleryRef,
  visibleItems,
  topPad,
  bottomPad,
  showBackTop,
  backToTop,
  updateViewTop,
  animateCards,
} = useVirtualGrid(
  filteredItems,
  computed(() => store.thumbSize),
)

// 画廊上方的统计行 / 工具栏高度变化会移动画廊顶边，主动校正窗口
// （条目数量 / 卡片宽度的校正已在 useVirtualGrid 内部）
watch(
  () => [store.sourceFilter, store.sortMode],
  () => updateViewTop(),
)

// 被“来源 / 搜索 / 模型”筛选挡住的已解析图片数量（用于空状态引导）
const hiddenCount = computed(() => {
  const shown = new Set(filteredItems.value)
  return store.items.filter((i) => i.status === 'done' && !shown.has(i)).length
})

// 已加载文件的总大小：状态行直观展示本批数据体量（万级扫描时对照内存 / 磁盘心里有数）
const totalBytes = computed(() => store.items.reduce((n, i) => n + i.size, 0))

/* ---------- 激活筛选 chips（F5）：每个条件可单独移除，不必整串重写 ---------- */
interface FilterChip {
  key: string
  label: string
  title: string
  remove: () => void
}

const SOURCE_CHIP_LABEL: Record<
  Exclude<SourceFilter, 'comfyui'>,
  'src.all' | 'src.a1111' | 'src.fooocus' | 'src.none' | 'src.error'
> = {
  all: 'src.all',
  a1111: 'src.a1111',
  fooocus: 'src.fooocus',
  none: 'src.none',
  error: 'src.error',
}

const filterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = []
  if (store.modelFilter) {
    const name = store.modelFilter
    chips.push({
      key: 'model',
      label: name,
      title: t('chip.modelTitle', { name }),
      remove: () => (store.modelFilter = null),
    })
  }
  if (store.sourceFilter !== 'comfyui') {
    const sf = store.sourceFilter
    chips.push({
      key: 'source',
      label: t(SOURCE_CHIP_LABEL[sf]),
      remove: () => (store.sourceFilter = 'comfyui'),
      title: t('chip.removeAria', { name: t(SOURCE_CHIP_LABEL[sf]) }),
    })
  }
  if (store.favOnly) {
    chips.push({
      key: 'fav',
      label: t('chip.favOnly'),
      title: t('chip.removeAria', { name: t('chip.favOnly') }),
      remove: () => (store.favOnly = false),
    })
  }
  if (store.dupeOnly) {
    chips.push({
      key: 'dupe',
      label: t('chip.dupeOnly'),
      title: t('chip.removeAria', { name: t('chip.dupeOnly') }),
      remove: () => (store.dupeOnly = false),
    })
  }
  if (store.fileDupeOnly) {
    chips.push({
      key: 'file-dupe',
      label: t('chip.fileDupeOnly'),
      title: t('chip.removeAria', { name: t('chip.fileDupeOnly') }),
      remove: () => (store.fileDupeOnly = false),
    })
  }
  // 搜索串的每个 token 一个 chip（含字段限定 / 排除条件），按原文位置移除
  tokenizeQuery(store.search).forEach((tk, i) => {
    chips.push({
      key: `t${i}-${tk.start}`,
      label: tk.text,
      title: t('chip.removeAria', { name: tk.text }),
      remove: () => (store.search = removeQueryToken(store.search, i)),
    })
  })
  return chips
})

function clearAllFilters() {
  store.search = ''
  store.modelFilter = null
  store.sourceFilter = 'comfyui'
  store.favOnly = false
  store.dupeOnly = false
  store.fileDupeOnly = false
}

// 任一筛选偏离默认且确实藏了图时，状态行显示命中数（搜索 / 筛选是否生效一目了然）
const filtersActive = computed(
  () =>
    store.search.trim() !== '' ||
    store.modelFilter !== null ||
    store.sourceFilter !== 'comfyui' ||
    store.dupeOnly ||
    store.fileDupeOnly ||
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
// 标题与 <html lang> 随界面语言走（A9）：index.html 的静态中文只在首帧存在
watchEffect(() => {
  document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en'
})
watchEffect(() => {
  const base = t('app.title')
  const total = store.items.length
  if (!total) {
    document.title = base
    return
  }
  const shown = filteredItems.value.length
  document.title =
    filtersActive.value && shown !== total ? `(${shown}/${total}) ${base}` : `(${total}) ${base}`
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
  if (!list.length) return
  const idx = list.findIndex((i) => i.id === current.value!.id)
  // 当前图被新筛选筛掉（如详情页一键套用筛选后 idx<0）：落到新筛选结果首张，导航不断链（A4）
  if (idx < 0) {
    current.value = list[0]!
    return
  }
  const next = idx + dir
  if (next < 0 || next >= list.length) return
  current.value = list[next]!
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

// 单张移除（可撤销）；若移除的正是抽屉里打开的这张，一并收起
function onRemove(item: ImageItem) {
  removeItemUndoable(item)
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
  removeItemsUndoable(removed)
  clearSelection()
  // 正打开的详情 / 对比图在被移除集合里时收起抽屉，避免裂图残影
  const gone = new Set(removed)
  closeDetailIfRemoved(gone)
  closeCompareIfRemoved(gone)
}

/** G3：重复治理——「每组保留最新」，确认后整批移除各同源组的旧张（可撤销） */
function onKeepLatestDupes() {
  const removed = keepLatestOfDupes(true)
  if (!removed.length) return
  const gone = new Set(removed)
  closeDetailIfRemoved(gone)
  closeCompareIfRemoved(gone)
}

/** FEAT-1：撤销最近一次移除，恢复条目 / 存档记录 / 预览 */
function onUndoRemove() {
  const n = undoLastRemoval()
  if (n) appMessage().success(t('undo.restored', { n }))
  else appMessage().info(t('undo.failed'))
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

/* ---------- 批量打标（F1）：与详情页标签编辑同一账本（按指纹跨会话记忆） ---------- */
const batchTagInput = ref('')

/** 输入建议：全库标签按频次排，前缀 / 子串命中过滤（与详情页建议同一数据源） */
const batchTagSuggestions = computed(() => {
  const q = batchTagInput.value.trim().toLowerCase()
  return tagCounts.value
    .filter((tg) => !q || tg.name.toLowerCase().includes(q))
    .slice(0, 8)
    .map((tg) => ({ label: tg.name, value: tg.name }))
})

function batchTag(on: boolean) {
  const tag = batchTagInput.value.trim()
  if (!tag || !selectedItems.value.length) return
  const n = setItemsTag(selectedItems.value, tag, on)
  if (n > 0) {
    if (on) appMessage().success(t('msg.tagApplied', { n, name: tag }))
    else appMessage().success(t('msg.tagRemoved', { n, name: tag }))
    batchTagInput.value = ''
  } else {
    appMessage().info(t('msg.tagNoChange'))
  }
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
  // 单键快捷操作不接管带修饰键的组合：Ctrl/⌘+F 属于浏览器查找，
  // Alt 组合属于系统 / 菜单快捷键，不应被当作收藏或删除（OPT-3）
  if (e.ctrlKey || e.metaKey || e.altKey) return
  // F：收藏 / 取消收藏当前图（与文件行星标按钮同一账本）；长按重复不反复切换
  if (!e.repeat && e.key.toLowerCase() === 'f') {
    toggleFavorite(current.value)
    e.preventDefault()
    return
  }
  // Delete：移除当前图并同位置补位前进（不绑 Backspace——语义过于接近「返回」，
  // 且移除会连带清掉存档记录，须用明确的按键防误触）；长按重复不连续删图
  if (!e.repeat && e.key === 'Delete') {
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
  removeItemUndoable(item)
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

/* ---------- FEAT-6：快捷键帮助面板 ---------- */
const shortcutRows = computed(() => [
  { keys: '← / →', label: t('shortcuts.nav') },
  { keys: 'F', label: t('shortcuts.fav') },
  { keys: 'Delete', label: t('shortcuts.remove') },
  { keys: 'Ctrl / ⌘ + A', label: t('shortcuts.selectAll') },
  { keys: 'Ctrl / ⌘ + V', label: t('shortcuts.paste') },
  { keys: 'Esc', label: t('shortcuts.escape') },
  { keys: '?', label: t('shortcuts.help') },
])

function onGlobalKeys(e: KeyboardEvent) {
  if (inEditable(e.target)) return
  // ?（Shift+/）：打开快捷键帮助；带修饰键时留给浏览器 / 系统
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
    e.preventDefault()
    shortcutsVisible.value = !shortcutsVisible.value
    return
  }
  // Ctrl/⌘+A：全选当前筛选结果（输入框内的原生全选不受影响）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    if (!filteredItems.value.length) return
    e.preventDefault()
    selectAllFiltered()
    return
  }
  // Esc：先清空选择；任一抽屉 / 帮助面板打开时 Esc 属于关面板，不动选择
  if (
    e.key === 'Escape' &&
    selectedIds.value.size &&
    !showDetail.value &&
    !showCompare.value &&
    !statsVisible.value &&
    !modelsVisible.value &&
    !shortcutsVisible.value
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
// 清空列表时收起详情抽屉并清空选择账本：顶栏「清空」绕过 App 的移除回调，
// 只关详情会留下已不存在条目的选中 id（OPT-3）
watch(
  () => store.items.length,
  (len) => {
    if (len === 0) {
      showDetail.value = false
      current.value = null
      clearSelection()
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
    const entry = dt.items[i]!.webkitGetAsEntry()
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
  try {
    const files = await collectDroppedFiles(e.dataTransfer)
    if (files.length) addFiles(files)
  } catch {
    // 拖拽目录读取失败（权限 / 句柄失效等）：明确提示并可改用按钮入口（OPT-4）
    appMessage().error(t('msg.dropFailed'))
  }
}
</script>

<template>
  <NConfigProvider
    :theme="store.dark ? darkTheme : null"
    :theme-overrides="themeOv"
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
            ><i class="dot" style="background: var(--violet)" /><b>{{ stats.fooocus }}</b>
            Fooocus</span
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

        <div
          v-if="filterChips.length"
          class="filter-chips"
          role="list"
          :aria-label="t('chip.barAria')"
        >
          <span v-for="c in filterChips" :key="c.key" class="chip" role="listitem">
            <span class="chip-label" :title="c.label">{{ c.label }}</span>
            <button
              type="button"
              class="chip-x"
              :title="c.title"
              :aria-label="c.title"
              @click="c.remove()"
            >
              <Icon name="x" :size="10" :stroke="2.4" />
            </button>
          </span>
          <!-- G3：重复治理入口——只在「只看重复」筛选激活时出现 -->
          <NPopconfirm v-if="store.dupeOnly" @positive-click="onKeepLatestDupes">
            <template #trigger>
              <button type="button" class="chip-clear" :title="t('chip.keepLatestConfirm')">
                <Icon name="trash" :size="11" />
                {{ t('chip.keepLatest') }}
              </button>
            </template>
            {{ t('chip.keepLatestConfirm') }}
          </NPopconfirm>
          <button type="button" class="chip-clear" @click="clearAllFilters">
            {{ t('chip.clearAll') }}
          </button>
        </div>

        <main ref="galleryRef" class="gallery" :style="{ '--card-min': `${store.thumbSize}px` }">
          <template v-if="filteredItems.length">
            <div :style="{ height: topPad + 'px' }" aria-hidden="true" />
            <div class="grid" :class="{ selecting: selectedItems.length > 0, anim: animateCards }">
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

        <div
          v-if="selectedItems.length"
          class="select-bar"
          role="toolbar"
          :aria-label="t('bar.toolbarAria')"
        >
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
          <NPopover trigger="click" placement="top" :style="{ maxWidth: '280px' }">
            <template #trigger>
              <NButton size="tiny" secondary>
                <template #icon><Icon name="tag" :size="12" /></template>
                {{ t('bar.tagSelected') }}
              </NButton>
            </template>
            <div class="batch-tag-pop">
              <NAutoComplete
                v-model:value="batchTagInput"
                size="small"
                :options="batchTagSuggestions"
                :placeholder="t('bar.tagPlaceholder')"
                :get-show="() => batchTagSuggestions.length > 0"
                blur-after-select
                @select="batchTag(true)"
                @keyup.enter="batchTag(true)"
              />
              <div class="batch-tag-actions">
                <NButton size="tiny" secondary @click="batchTag(true)">{{
                  t('bar.tagApply')
                }}</NButton>
                <NButton
                  size="tiny"
                  secondary
                  :disabled="!batchTagInput.trim()"
                  @click="batchTag(false)"
                  >{{ t('bar.tagRemoveFromSelected') }}</NButton
                >
              </div>
            </div>
          </NPopover>
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

        <!-- FEAT-1：移除撤销条（10 秒窗口）。有批量选择条时上移，避免遮挡 -->
        <div
          v-if="undoState"
          class="undo-bar"
          :class="{ raised: selectedItems.length > 0 }"
          role="status"
          aria-live="polite"
        >
          <span class="undo-text">{{ t('undo.removed', { n: undoState.count }) }}</span>
          <button type="button" class="undo-action" @click="onUndoRemove">
            {{ t('undo.action') }}
          </button>
          <button
            type="button"
            class="undo-dismiss"
            :title="t('undo.dismiss')"
            :aria-label="t('undo.dismiss')"
            @click="dismissUndo"
          >
            <Icon name="x" :size="11" :stroke="2.2" />
          </button>
        </div>

        <!-- FEAT-6：快捷键帮助（? 或顶栏帮助按钮打开） -->
        <NModal
          v-model:show="shortcutsVisible"
          preset="card"
          :title="t('shortcuts.title')"
          style="width: 460px; max-width: calc(100vw - 32px)"
        >
          <dl class="shortcut-list">
            <template v-for="row in shortcutRows" :key="row.keys">
              <dt>
                <kbd>{{ row.keys }}</kbd>
              </dt>
              <dd>{{ row.label }}</dd>
            </template>
          </dl>
          <p class="shortcut-note">{{ t('shortcuts.note') }}</p>
        </NModal>

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
