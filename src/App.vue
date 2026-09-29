<script setup lang="ts">
import { computed, ref, watchEffect, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  NButton,
  NConfigProvider,
  NDropdown,
  NMessageProvider,
  NPopconfirm,
  darkTheme,
  dateZhCN,
  zhCN,
  useMessage,
} from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import TopBar from './components/TopBar.vue'
import ImageCard from './components/ImageCard.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import EmptyState from './components/EmptyState.vue'
import { addFiles, filteredItems, parsing, rangeIds, removeItem, stats, store } from './composables/store'
import { buildExportCsv, buildExportJson } from './lib/export'
import { copyText, downloadText } from './lib/utils'
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

/* ---------- 分页加载 ---------- */
const PAGE = 120
const shown = ref(PAGE)
watch(
  () => [store.search, store.modelFilter, store.sourceFilter, store.sortMode],
  () => {
    shown.value = PAGE
  },
)
const visibleItems = computed(() => filteredItems.value.slice(0, shown.value))
const remaining = computed(() => filteredItems.value.length - visibleItems.value.length)
// 被“来源 / 搜索 / 模型”筛选挡住的已解析图片数量（用于空状态引导）
const hiddenCount = computed(() => {
  const shown = new Set(filteredItems.value)
  return store.items.filter((i) => i.status === 'done' && !shown.has(i)).length
})
function showAll() {
  store.sourceFilter = 'all'
  store.search = ''
  store.modelFilter = null
}

/* ---------- 详情 ---------- */
const current = ref<ImageItem | null>(null)
const showDetail = ref(false)
const message = useMessage()
function open(item: ImageItem) {
  current.value = item
  showDetail.value = true
}
// 单张移除；若移除的正是抽屉里打开的这张，一并收起
function onRemove(item: ImageItem) {
  removeItem(item)
  selectedIds.value.delete(item.id)
  if (current.value === item) {
    showDetail.value = false
    current.value = null
  }
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
  for (const it of selectedItems.value) removeItem(it)
  clearSelection()
}

async function batchCopyPrompts() {
  const prompts = selectedItems.value
    .filter((i) => i.status === 'done' && i.params)
    .map((i) => i.params!.positive.join('\n'))
    .filter((s) => s.trim() !== '')
  if (!prompts.length) {
    message.warning('所选图片中还没有已解析出提示词的项')
    return
  }
  const ok = await copyText(prompts.join('\n'))
  if (ok) message.success(`已复制 ${prompts.length} 张图片的正向提示词`)
  else message.error('复制失败，请手动选择文本复制')
}

const exportOptions = [
  { label: '导出 JSON', key: 'json' },
  { label: '导出 CSV (Excel)', key: 'csv' },
]

function batchExport(key: string | number) {
  if (parsing.value) {
    message.warning('扫描仍在进行，请等扫描完成后再导出')
    return
  }
  const items = selectedItems.value.filter((i) => i.status === 'done' || i.status === 'error')
  if (!items.length) {
    message.warning('所选图片中还没有可导出的结果')
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  if (key === 'csv') downloadText(`comfyui-info-selected-${stamp}.csv`, buildExportCsv(items), 'text/csv')
  else downloadText(`comfyui-info-selected-${stamp}.json`, buildExportJson(items))
}

/* ---------- 键盘导航（抽屉打开时 ←/→ 沿当前筛选顺序浏览） ---------- */
function onKeydown(e: KeyboardEvent) {
  if (!showDetail.value || !current.value) return
  const t = e.target as HTMLElement | null
  if (
    t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  ) {
    return // 焦点在输入框内时方向键属于光标，不切换图片
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const list = filteredItems.value
  const idx = list.findIndex((i) => i.id === current.value!.id)
  const next = idx + (e.key === 'ArrowRight' ? 1 : -1)
  if (idx < 0 || next < 0 || next >= list.length) return
  current.value = list[next]
  e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

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
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NMessageProvider>
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
            >已加载 <b>{{ store.items.length }}</b></span
          >
          <span
            ><i class="dot" style="background: var(--accent)" /><b>{{ stats.comfyui }}</b> ComfyUI
            原图</span
          >
          <span
            ><i class="dot" style="background: var(--teal)" /><b>{{ stats.a1111 }}</b> A1111</span
          >
          <span
            ><i class="dot" style="background: var(--gray-src)" /><b>{{ stats.none }}</b>
            无元数据</span
          >
          <span
            v-if="stats.error"
            class="stat-error"
            role="button"
            tabindex="0"
            title="点击查看解析失败的图片"
            @click="store.sourceFilter = 'error'"
            @keydown.enter.prevent="store.sourceFilter = 'error'"
            @keydown.space.prevent="store.sourceFilter = 'error'"
          >
            <i class="dot" style="background: var(--danger)" /><b>{{ stats.error }}</b> 解析失败
          </span>
          <span v-if="parsing" style="color: var(--accent)">扫描中…</span>
        </div>

        <main class="gallery">
          <div v-if="visibleItems.length" class="grid" :class="{ selecting: selectedItems.length > 0 }">
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
            />
          </div>
          <EmptyState
            v-else
            :filtered="store.items.length > 0"
            :hidden-count="hiddenCount"
            @show-all="showAll"
          />
          <div v-if="remaining > 0" class="more-row">
            <NButton size="small" secondary @click="shown += PAGE">
              加载更多（还有 {{ remaining }} 张）
            </NButton>
          </div>
        </main>

        <div v-if="selectedItems.length" class="select-bar" role="toolbar" aria-label="批量操作">
          <span class="sel-count">已选 <b>{{ selectedItems.length }}</b> 张</span>
          <NButton size="tiny" secondary @click="selectAllFiltered">全选筛选结果</NButton>
          <NButton size="tiny" secondary @click="batchCopyPrompts">复制提示词</NButton>
          <NDropdown trigger="click" :options="exportOptions" @select="batchExport">
            <NButton size="tiny" secondary>导出选中</NButton>
          </NDropdown>
          <NPopconfirm @positive-click="batchRemove">
            <template #trigger>
              <NButton size="tiny" secondary type="error">移除选中</NButton>
            </template>
            确定移除选中的 {{ selectedItems.length }} 张图片？
          </NPopconfirm>
          <NButton size="tiny" quaternary @click="clearSelection">取消选择</NButton>
        </div>

        <DetailDrawer v-model:show="showDetail" :item="current" />

        <div v-if="dragging" class="drop-overlay">
          <div class="inner">松开以添加图片 / 文件夹</div>
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
