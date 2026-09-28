<script setup lang="ts">
import { computed, ref, watchEffect, watch } from 'vue'
import { NButton, NConfigProvider, NMessageProvider, darkTheme, dateZhCN, zhCN } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import TopBar from './components/TopBar.vue'
import ImageCard from './components/ImageCard.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import EmptyState from './components/EmptyState.vue'
import { addFiles, filteredItems, parsing, stats, store } from './composables/store'
import type { ImageItem } from './types'

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
  () => [store.search, store.modelFilter, store.sourceFilter],
  () => {
    shown.value = PAGE
  },
)
const visibleItems = computed(() => filteredItems.value.slice(0, shown.value))
const remaining = computed(() => filteredItems.value.length - visibleItems.value.length)
// 被“来源 / 搜索 / 模型”筛选挡住的已解析图片数量（用于空状态引导）
const hiddenCount = computed(
  () => store.items.filter((i) => i.status === 'done').length - filteredItems.value.length,
)
function showAll() {
  store.sourceFilter = 'all'
  store.search = ''
  store.modelFilter = null
}

/* ---------- 详情 ---------- */
const current = ref<ImageItem | null>(null)
const showDetail = ref(false)
function open(item: ImageItem) {
  current.value = item
  showDetail.value = true
}

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

async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = []
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i].webkitGetAsEntry()
    if (entry) entries.push(entry)
  }
  if (!entries.length) return Array.from(dt.files)

  const out: File[] = []
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      )
      if (file) out.push(file)
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
          <span>已加载 <b>{{ store.items.length }}</b></span>
          <span><i class="dot" style="background: var(--accent)" /><b>{{ stats.comfyui }}</b> ComfyUI 原图</span>
          <span><i class="dot" style="background: var(--teal)" /><b>{{ stats.a1111 }}</b> A1111</span>
          <span><i class="dot" style="background: var(--gray-src)" /><b>{{ stats.none }}</b> 无元数据</span>
          <span v-if="parsing" style="color: var(--accent)">扫描中…</span>
        </div>

        <main class="gallery">
          <div v-if="visibleItems.length" class="grid">
            <ImageCard
              v-for="(it, idx) in visibleItems"
              :key="it.id"
              :item="it"
              :index="idx"
              @open="open(it)"
            />
          </div>
          <EmptyState v-else :filtered="store.items.length > 0" :hidden-count="hiddenCount" @show-all="showAll" />
          <div v-if="remaining > 0" class="more-row">
            <NButton size="small" secondary @click="shown += PAGE">
              加载更多（还有 {{ remaining }} 张）
            </NButton>
          </div>
        </main>

        <DetailDrawer v-model:show="showDetail" :item="current" />

        <div v-if="dragging" class="drop-overlay">
          <div class="inner">松开以添加图片 / 文件夹</div>
        </div>
      </div>
    </NMessageProvider>
  </NConfigProvider>
</template>
