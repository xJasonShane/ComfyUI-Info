<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  NAutoComplete,
  NButton,
  NDrawer,
  NDropdown,
  NTabPane,
  NTabs,
  NSwitch,
  useMessage,
} from 'naive-ui'
import type { ImageItem } from '../types'
import type { SamplerInfo } from '../types'
import Icon from './Icon.vue'
import ImageZoomOverlay from './ImageZoomOverlay.vue'
import { baseName, copyText, downloadBinary, downloadText, humanBytes } from '../lib/utils'
import { buildParamsSummary } from '../lib/export'
import {
  addFiles,
  allTagNames,
  favoriteFlags,
  filteredItems,
  retryItem,
  ensureItemThumb,
  ensureItemUrl,
  store,
  tagLists,
  toggleFavorite,
  toggleItemTag,
} from '../composables/store'
import { useDrawerWidth } from '../composables/ui'
import { dateLocale, t } from '../locales'

const props = defineProps<{ item: ImageItem | null }>()
const show = defineModel<boolean>('show', { default: false })
const emit = defineEmits<{ nav: [dir: 1 | -1]; compare: [dir: 1 | -1] }>()
const message = useMessage()

const {
  width: drawerWidth,
  dragging: drawerDragging,
  onResizerDown,
  onResizerMove,
  onResizerUp,
} = useDrawerWidth('detail', 940)

const p = computed(() => props.item?.params)

/* ---------- 大图两侧上一张 / 下一张（与键盘 ← / → 同序：沿当前筛选结果浏览） ---------- */
const navIndex = computed(() =>
  props.item ? filteredItems.value.findIndex((i) => i.id === props.item!.id) : -1,
)
const hasPrev = computed(() => navIndex.value > 0)
const hasNext = computed(
  () => navIndex.value >= 0 && navIndex.value < filteredItems.value.length - 1,
)

/**
 * 与相邻图片对比：双方都已解析出参数才可对比（与批量条 canCompare 同一门槛）；
 * 邻居沿当前筛选顺序取，方向由调用处（下拉选项 / 事件）决定
 */
const neighborParsed = (dir: 1 | -1) => {
  if (navIndex.value < 0) return false
  const n = filteredItems.value[navIndex.value + dir]
  return !!n && n.status === 'done' && !!n.params && !!p.value
}
const canComparePrev = computed(() => hasPrev.value && neighborParsed(-1))
const canCompareNext = computed(() => hasNext.value && neighborParsed(1))

/** 文件行对比下拉：与上一张 / 下一张对比，不可用方向置灰 */
const compareOptions = computed(() => [
  { label: t('detail.comparePrev'), key: '-1', disabled: !canComparePrev.value },
  { label: t('detail.compareNext'), key: '1', disabled: !canCompareNext.value },
])

function onCompareSelect(key: string | number) {
  emit('compare', Number(key) === 1 ? 1 : -1)
}

/** 收藏标记：与卡片共用 favoriteFlags 全量表 */
const faved = computed(() =>
  props.item ? (favoriteFlags.value.get(props.item.id) ?? false) : false,
)

/* ---------- FEAT-8：详情大图点击放大（点遮罩关闭，切图 / 关抽屉自动收起） ---------- */
const zoomed = ref(false)

// 放大态交互（滚轮锚点缩放 / 拖拽平移 / 键盘缩放 / Esc 分层）整体在
// components/ImageZoomOverlay.vue（D3）：zoomed 只管开关，组件卸载即复位
watch(
  () => props.item?.id,
  () => {
    zoomed.value = false
    actualDims.value = null
  },
)
watch(show, (v) => {
  if (!v) {
    zoomed.value = false
    playing.value = false
  }
})

/* ---------- 幻灯片自动播放：沿当前筛选顺序定时切到下一张，末张 / 关抽屉自动停止 ---------- */
const SLIDE_INTERVAL_MS = 4000
const playing = ref(false)
let playTimer: ReturnType<typeof setInterval> | null = null

watch(playing, (on) => {
  if (on) {
    playTimer = setInterval(() => {
      if (!hasNext.value) playing.value = false
      else emit('nav', 1)
    }, SLIDE_INTERVAL_MS)
  } else if (playTimer !== null) {
    clearInterval(playTimer)
    playTimer = null
  }
})

onBeforeUnmount(() => {
  if (playTimer !== null) clearInterval(playTimer)
})

/* ---------- 实际分辨率标注：图片解码完成后读取原始像素尺寸 ---------- */
const actualDims = ref<{ w: number; h: number } | null>(null)

/** 存档项只有内嵌缩略图时可预览但不能放大，也不把缩略图尺寸当作原图尺寸（FEAT-3） */
const isThumbOnly = computed(() => !!props.item && !props.item.url && !!props.item.thumb)
const previewSrc = computed(() => props.item?.url || props.item?.thumb || '')

function onImgLoad(e: Event) {
  if (isThumbOnly.value) return
  const img = e.target as HTMLImageElement
  actualDims.value = { w: img.naturalWidth, h: img.naturalHeight }
}

/**
 * 实际尺寸与参数出图尺寸的对比标注：等比例不一致即放大 / 缩小（高清修复、
 * 后处理缩放），非等比例（裁剪、旋转）只提示不一致；一致或无参数时不标注。
 */
const dimsNote = computed(() => {
  const a = actualDims.value
  const params = p.value
  if (!a || !params?.width || !params.height) return ''
  if (a.w === params.width && a.h === params.height) return ''
  const rx = a.w / params.width
  const ry = a.h / params.height
  if (Math.abs(rx - ry) >= 0.01) return t('detail.dimsMismatch')
  const r = Math.round(((rx + ry) / 2) * 100) / 100
  return r > 1 ? t('detail.upscaled', { r }) : t('detail.downscaled', { r })
})

const dimsTitle = computed(() => {
  const a = actualDims.value
  const params = p.value
  if (!a || !params?.width || !params.height || !dimsNote.value) return undefined
  return t('detail.dimsDiffTitle', { w: a.w, h: a.h, pw: params.width, ph: params.height })
})

// P2：详情大图与抽屉浏览同样按需创建预览 URL
// F2 / FEAT-3：存档项再按需物化内嵌缩略图，无原文件时也能在详情预览
watch(
  () => props.item?.id,
  () => {
    if (!props.item) return
    ensureItemUrl(props.item)
    if (props.item.detached) void ensureItemThumb(props.item)
  },
  { immediate: true },
)

/* ---------- FEAT-3：存档项重新关联原文件 ---------- */
const reattachInput = ref<HTMLInputElement | null>(null)

function pickReattachFile() {
  reattachInput.value?.click()
}

function onReattachFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const item = props.item
  if (!file || !item?.detached) return
  // 沿用存档项已知的相对路径 / 目录来源：用户明确为该卡片选择原文件，
  // 指纹才能命中并原地回挂（单选文件本身不带路径信息）
  addFiles([{ file, path: item.path, sourceId: item.sourceId }])
  message.success(t('detail.reattached'))
}

const fileTime = computed(() => {
  if (!props.item) return ''
  return new Date(props.item.mtime).toLocaleString(dateLocale(), {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
})

/** 当前条目上实际可用的 JSON 页签（与模板里各 NTabPane 的渲染条件保持一致） */
function availableTabs(item: ImageItem): string[] {
  const tabs: string[] = []
  if (item.raw.parameters) tabs.push('raw')
  if (item.raw.prompt) tabs.push('prompt')
  // Fooocus 的 parameters 是参数 JSON，不是 UI 工作流，避免展示空 workflow 页签
  if (item.raw.source !== 'a1111' && item.raw.source !== 'fooocus') tabs.push('workflow')
  return tabs
}

const tab = ref('prompt')
// 切换图片时保留用户所在页签（如对照多张图的 workflow）；新条目没有该页签时才回退默认
watch(
  () => props.item?.id,
  () => {
    const it = props.item
    if (!it) return
    const tabs = availableTabs(it)
    if (tabs.includes(tab.value)) return
    tab.value = it.source === 'a1111' && tabs.includes('raw') ? 'raw' : (tabs[0] ?? 'prompt')
  },
)

/** 是否渲染 JSON 页签区：有任一原始文本就展示（含「元数据存在但解析失败」的场景） */
const showJsonTabs = computed(() => {
  const it = props.item
  return !!it && !!(it.raw.parameters || it.raw.prompt || it.raw.workflow)
})

/** 元数据文本存在但结构化参数缺失：JSON 损坏 / 无法解析，或仅有 UI 工作流（无 API prompt），与「无元数据」区分开 */
const corruptRawText = computed(() => {
  const it = props.item
  return (
    !!it &&
    it.status === 'done' &&
    !it.params &&
    !!(it.raw.prompt || it.raw.parameters || it.raw.workflow)
  )
})

/** 元数据存在但无结构化参数时的解释文案：区分「仅有 UI 工作流」与「JSON / 参数文本损坏」 */
const corruptHint = computed(() => {
  const it = props.item
  if (!it) return ''
  if (!it.raw.prompt && !it.raw.parameters && it.raw.workflow) {
    return t('detail.corruptUiOnly')
  }
  return it.raw.source === 'comfyui' ? t('detail.corruptJson') : t('detail.corruptText')
})

/** 参数行：value 供展示，filter / modelFilter 存在时行尾有一键筛选按钮 */
interface InfoRow {
  label: string
  value: string
  /** 定向搜索串（如 `vae:"…"` / `steps:30`），点击写入搜索框 */
  filter?: string
  /** 单模型走 modelFilter 下拉（与统计抽屉一致），多模型才退到定向搜索 */
  modelFilter?: string
}

const generalRows = computed<InfoRow[]>(() => {
  const params = p.value
  const rows: InfoRow[] = []
  if (!params) return rows
  if (params.models.length) {
    rows.push({
      label: t('detail.model'),
      value: params.modelHash
        ? `${params.models.join(' + ')} · ${params.modelHash}`
        : params.models.join(' + '),
      ...(params.models.length === 1
        ? { modelFilter: params.models[0] }
        : { filter: params.models.map((m) => `model:"${m}"`).join(' ') }),
    })
  }
  if (params.vaes.length)
    rows.push({
      label: t('detail.vae'),
      value: params.vaes.join(' + '),
      filter: params.vaes.map((v) => `vae:"${v}"`).join(' '),
    })
  if (params.clipSkip !== undefined)
    rows.push({
      label: t('detail.clipSkip'),
      value: String(params.clipSkip),
      filter: `clip:${params.clipSkip}`,
    })
  if (params.width && params.height) {
    let s = `${params.width} × ${params.height}`
    if (params.batch && params.batch > 1) s += t('detail.perBatch', { n: params.batch })
    rows.push({
      label: t('detail.size'),
      value: s,
      filter: `w:${params.width} h:${params.height}`,
    })
  }
  if (params.upscalers.length)
    rows.push({
      label: t('detail.upscaler'),
      value: params.upscalers.join(' + '),
      filter: params.upscalers.map((v) => `upscale:"${v}"`).join(' '),
    })
  if (params.controlNets.length)
    rows.push({
      label: t('detail.controlnet'),
      value: params.controlNets.join(' + '),
      filter: params.controlNets.map((v) => `controlnet:"${v}"`).join(' '),
    })
  if (params.nodeCount)
    rows.push({ label: t('detail.nodeCount'), value: t('detail.nodes', { n: params.nodeCount }) })
  return rows
})

const sampler = computed<SamplerInfo | undefined>(() => p.value?.samplers?.[0])

const samplerRows = computed<InfoRow[]>(() => {
  const s = sampler.value
  const rows: InfoRow[] = []
  if (!s) return rows
  if (s.sampler)
    rows.push({
      label: t('detail.sampler'),
      value: s.sampler,
      filter: `sampler:"${s.sampler}"`,
    })
  if (s.scheduler)
    rows.push({
      label: t('detail.scheduler'),
      value: s.scheduler,
      filter: `scheduler:"${s.scheduler}"`,
    })
  if (s.steps != null)
    rows.push({ label: t('detail.steps'), value: String(s.steps), filter: `steps:${s.steps}` })
  if (s.cfg != null)
    rows.push({ label: t('detail.cfg'), value: String(s.cfg), filter: `cfg:${s.cfg}` })
  if (s.seed) rows.push({ label: t('detail.seed'), value: s.seed, filter: `seed:${s.seed}` })
  if (s.denoise != null) rows.push({ label: t('detail.denoise'), value: String(s.denoise) })
  return rows
})

/**
 * 一键筛选：写入定向搜索串并关闭抽屉，回到画廊即见同参图集
 * （与统计抽屉点击条目同一交互语义：替换当前搜索条件）。
 */
function applySearch(query: string) {
  store.search = query
  show.value = false
}

function applyRowFilter(row: InfoRow) {
  if (row.modelFilter) store.modelFilter = row.modelFilter
  else if (row.filter) applySearch(row.filter)
}

/** LoRA 行的一键筛选：定向 `lora:"…"`（含空格名称整体成词） */
function filterLora(name: string) {
  applySearch(`lora:"${name}"`)
}

/* ---------- 自定义标签：详情页增删（按指纹跨会话记忆），点击标签名即筛选 ---------- */
const currentTags = computed(() => (props.item ? (tagLists.value.get(props.item.id) ?? []) : []))
const tagInput = ref('')

/** 输入建议：全库已有标签按使用频次排，排除当前条目已带的 */
const tagSuggestions = computed(() =>
  allTagNames.value
    .filter((t) => !currentTags.value.includes(t))
    .slice(0, 8)
    .map((t) => ({ label: t, value: t })),
)

function addTag(raw?: string) {
  const tag = (raw ?? tagInput.value).trim()
  if (!tag || !props.item) return
  if (!currentTags.value.includes(tag)) toggleItemTag(props.item, tag)
  tagInput.value = ''
}

function removeTag(tag: string) {
  if (props.item) toggleItemTag(props.item, tag)
}

function filterTag(tag: string) {
  applySearch(`tag:"${tag}"`)
}

function stageText(s: SamplerInfo): string {
  const parts = [
    `steps ${s.steps ?? '-'}`,
    `cfg ${s.cfg ?? '-'}`,
    `seed ${s.seed ?? '-'}`,
    `denoise ${s.denoise ?? '-'}`,
    s.sampler ? `${t('detail.sampler')} ${s.sampler}` : '',
  ].filter(Boolean)
  return `#${s.nodeId} ${s.classType} ｜ ${parts.join(' · ')}`
}

const positiveText = computed(() => p.value?.positive.join('\n') ?? '')
const negativeText = computed(() => p.value?.negative.join('\n') ?? '')

/* ---------- JSON 页签格式化显示（仅影响展示；复制 / 下载始终使用原文） ---------- */
const prettyJson = ref(false)

/** pretty-print；JSON 损坏无法解析时原样展示，与「原文排查」场景兼容 */
function prettyOrRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const jsonText = computed(() => {
  if (!props.item) return ''
  if (tab.value === 'workflow') {
    const raw = props.item.raw.workflow
    if (!raw) return t('detail.noWorkflow')
    return prettyJson.value ? prettyOrRaw(raw) : raw
  }
  const raw = props.item.raw.prompt ?? ''
  return raw && prettyJson.value ? prettyOrRaw(raw) : raw
})

async function copy(value: string | undefined, label: string) {
  if (!value) return
  const ok = await copyText(value)
  if (ok) message.success(t('detail.copied', { label }))
  else message.error(t('common.copyFailed'))
}

/** 一键复制 A1111 风格参数摘要（可贴回 WebUI 复现或留作记录） */
function copySummary() {
  const params = p.value
  if (!params) return
  void copy(buildParamsSummary(params), t('detail.copySummary'))
}

function downloadJson(text: string | undefined, suffix: string) {
  if (!props.item || !text) return
  downloadText(`${baseName(props.item.name)}.${suffix}`, text)
}

/* ---------- 详情页图片操作：复制图片到剪贴板 / 下载原图 ---------- */
function downloadImage() {
  const it = props.item
  if (!it?.file) return
  downloadBinary(it.name, it.file)
}

/** 任意格式图片 → PNG Blob：剪贴板图片只接受 image/png，JPEG / WebP 需经画布转码 */
async function imagePngBlob(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bmp, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('canvas toBlob failed')
    return blob
  } finally {
    bmp.close()
  }
}

async function copyImage() {
  const it = props.item
  if (!it?.file) return
  try {
    // Safari 需在用户手势内传入 Promise 形态的 ClipboardItem（延迟渲染）；Chromium 97+ 同样支持
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imagePngBlob(it.file) })])
    message.success(t('detail.imageCopied'))
  } catch {
    // 旧浏览器不支持 Promise 形态：先拿到 blob 再写入一次
    try {
      const blob = await imagePngBlob(it.file)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      message.success(t('detail.imageCopied'))
    } catch {
      message.error(t('detail.imageCopyFailed'))
    }
  }
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
      <div v-if="item" class="detail">
        <div class="detail-view">
          <img
            v-if="previewSrc"
            :src="previewSrc"
            :alt="item.name"
            :class="{ 'thumb-only': isThumbOnly }"
            :title="isThumbOnly ? t('detail.thumbPreview') : t('detail.zoomIn')"
            @load="onImgLoad"
            @click="!isThumbOnly && (zoomed = true)"
          />
          <div v-if="isThumbOnly" class="img-dims">{{ t('detail.thumbPreview') }}</div>
          <div v-else-if="actualDims" class="img-dims" :title="dimsTitle">
            {{ actualDims.w }} × {{ actualDims.h }} px<span v-if="dimsNote"> · {{ dimsNote }}</span>
          </div>
          <button
            v-if="hasPrev"
            class="img-nav prev"
            type="button"
            :title="t('detail.prev')"
            :aria-label="t('detail.prev')"
            @click="emit('nav', -1)"
          >
            <Icon name="chevron-left" :size="18" />
          </button>
          <button
            v-if="hasNext"
            class="img-nav next"
            type="button"
            :title="t('detail.next')"
            :aria-label="t('detail.next')"
            @click="emit('nav', 1)"
          >
            <Icon name="chevron-right" :size="18" />
          </button>
          <div v-if="item.url && item.file" class="img-actions">
            <NButton
              size="tiny"
              secondary
              :title="t('detail.copyImage')"
              :aria-label="t('detail.copyImage')"
              @click="copyImage"
            >
              <template #icon><Icon name="copy" :size="13" /></template>
            </NButton>
            <NButton
              size="tiny"
              secondary
              :title="t('detail.downloadImage')"
              :aria-label="t('detail.downloadImage')"
              @click="downloadImage"
            >
              <template #icon><Icon name="download" :size="13" /></template>
            </NButton>
          </div>
          <div v-if="!previewSrc" class="detail-noimg">
            <Icon :name="item.metaOnly ? 'file-text' : 'image'" :size="26" :stroke="1.6" />
            <span>{{
              item.metaOnly ? t('detail.metaFileNoPreview') : t('detail.imageNotLoaded')
            }}</span>
            <span v-if="!item.metaOnly" class="tip">{{ t('detail.reattachHint') }}</span>
            <NButton v-if="item.detached" size="small" secondary @click="pickReattachFile">{{
              t('detail.reattach')
            }}</NButton>
          </div>
        </div>
        <ImageZoomOverlay
          v-if="zoomed && item.url"
          :src="item.url"
          :alt="item.name"
          @close="zoomed = false"
        />

        <div class="detail-panel">
          <div class="fileline">
            <span style="flex: 1" :title="item.path ?? item.name">{{
              item.path ?? item.name
            }}</span>
            <NButton
              size="tiny"
              quaternary
              circle
              :title="t('detail.copyPath')"
              :aria-label="t('detail.copyPath')"
              @click="copy(item.path ?? item.name, t('detail.copyPath'))"
            >
              <template #icon><Icon name="copy" :size="12" /></template>
            </NButton>
            <NButton
              v-if="item.detached"
              size="tiny"
              quaternary
              circle
              :title="t('detail.reattach')"
              :aria-label="t('detail.reattach')"
              @click="pickReattachFile"
            >
              <template #icon><Icon name="folder" :size="12" /></template>
            </NButton>
            <span :title="new Date(item.mtime).toLocaleString()">{{ fileTime }}</span>
            <span>{{ humanBytes(item.size) }}</span>
            <NButton
              size="tiny"
              quaternary
              circle
              :title="playing ? t('detail.pause') : t('detail.play')"
              :aria-label="playing ? t('detail.pause') : t('detail.play')"
              :aria-pressed="playing"
              @click="playing = !playing"
            >
              <template #icon><Icon :name="playing ? 'pause' : 'play'" :size="13" /></template>
            </NButton>
            <NDropdown
              trigger="click"
              placement="bottom-end"
              :options="compareOptions"
              @select="onCompareSelect"
            >
              <NButton
                size="tiny"
                quaternary
                circle
                :title="t('detail.compareTitle')"
                :aria-label="t('detail.compareTitle')"
              >
                <template #icon><Icon name="git-compare" :size="13" /></template>
              </NButton>
            </NDropdown>
            <NButton
              size="tiny"
              quaternary
              circle
              :title="faved ? t('card.unfav') : t('card.fav')"
              :aria-label="t('card.favAria')"
              :aria-pressed="faved"
              @click="toggleFavorite(item)"
            >
              <template #icon><Icon :name="faved ? 'star-filled' : 'star'" :size="14" /></template>
            </NButton>
            <NButton
              size="tiny"
              quaternary
              circle
              :aria-label="t('detail.close')"
              @click="show = false"
            >
              <template #icon><Icon name="x" :size="13" /></template>
            </NButton>
          </div>

          <template v-if="p">
            <div class="section">
              <div class="section-title">
                <span>{{ t('detail.genParams') }}</span>
                <NButton size="tiny" quaternary @click="copySummary">
                  <template #icon><Icon name="copy" :size="13" /></template>
                  {{ t('detail.copySummary') }}
                </NButton>
              </div>
              <dl class="kv">
                <template v-for="(row, i) in generalRows" :key="i">
                  <dt>{{ row.label }}</dt>
                  <dd>
                    <span class="kv-val">{{ row.value }}</span>
                    <button
                      v-if="row.filter || row.modelFilter"
                      class="kv-copy"
                      type="button"
                      :title="t('detail.filterBy')"
                      :aria-label="t('detail.filterBy')"
                      @click="applyRowFilter(row)"
                    >
                      <Icon name="filter" :size="11" :stroke="2.2" />
                    </button>
                    <button
                      class="kv-copy"
                      type="button"
                      :title="t('detail.copyField', { name: row.label })"
                      @click="copy(row.value, row.label)"
                    >
                      <Icon name="copy" :size="11" :stroke="2.2" />
                    </button>
                  </dd>
                </template>
              </dl>
            </div>

            <div v-if="samplerRows.length" class="section">
              <div class="section-title">
                <span
                  >{{ t('detail.samplerParams')
                  }}<template v-if="p.samplers.length > 1">{{
                    t('detail.stages', { n: p.samplers.length })
                  }}</template></span
                >
              </div>
              <dl v-if="p.samplers.length === 1" class="kv">
                <template v-for="(row, i) in samplerRows" :key="i">
                  <dt>{{ row.label }}</dt>
                  <dd>
                    <span class="kv-val">{{ row.value }}</span>
                    <button
                      v-if="row.filter"
                      class="kv-copy"
                      type="button"
                      :title="t('detail.filterBy')"
                      :aria-label="t('detail.filterBy')"
                      @click="applyRowFilter(row)"
                    >
                      <Icon name="filter" :size="11" :stroke="2.2" />
                    </button>
                    <button
                      class="kv-copy"
                      type="button"
                      :title="t('detail.copyField', { name: row.label })"
                      @click="copy(row.value, row.label)"
                    >
                      <Icon name="copy" :size="11" :stroke="2.2" />
                    </button>
                  </dd>
                </template>
              </dl>
              <div v-else>
                <div v-for="s in p.samplers" :key="s.nodeId" class="stage-row">
                  <span class="txt">{{ stageText(s) }}</span>
                </div>
              </div>
            </div>

            <div v-if="p.loras.length" class="section">
              <div class="section-title">{{ t('detail.loraCount', { n: p.loras.length }) }}</div>
              <div v-for="l in p.loras" :key="l.name" class="stage-row">
                <span class="tag">{{ t('detail.loraTag') }}</span>
                <span class="txt">
                  {{ l.name
                  }}{{
                    t('detail.loraStrength', {
                      m: l.strengthModel ?? '-',
                      c: l.strengthClip ?? '-',
                      hash: l.hash ? ` · ${l.hash}` : '',
                    })
                  }}
                </span>
                <button
                  class="kv-copy"
                  type="button"
                  :title="t('detail.filterBy')"
                  :aria-label="t('detail.filterBy')"
                  @click="filterLora(l.name)"
                >
                  <Icon name="filter" :size="11" :stroke="2.2" />
                </button>
                <button
                  class="kv-copy"
                  type="button"
                  :title="t('detail.copyLoraName')"
                  @click="copy(l.name, t('detail.loraTag'))"
                >
                  <Icon name="copy" :size="11" :stroke="2.2" />
                </button>
              </div>
            </div>

            <div v-if="positiveText" class="section">
              <div class="section-title">
                <span>{{ t('detail.positive') }}</span>
                <NButton size="tiny" quaternary @click="copy(positiveText, t('detail.positive'))">
                  <template #icon><Icon name="copy" :size="13" /></template>
                  {{ t('common.copy') }}
                </NButton>
              </div>
              <pre class="prompt-text">{{ positiveText }}</pre>
            </div>

            <div v-if="negativeText" class="section">
              <div class="section-title">
                <span>{{ t('detail.negative') }}</span>
                <NButton size="tiny" quaternary @click="copy(negativeText, t('detail.negative'))">
                  <template #icon><Icon name="copy" :size="13" /></template>
                  {{ t('common.copy') }}
                </NButton>
              </div>
              <pre class="prompt-text">{{ negativeText }}</pre>
            </div>
          </template>

          <div v-else-if="item.status === 'error'" class="notice">
            <span class="notice-title">{{ t('detail.parseFailed') }}</span>
            <p class="err-message">{{ item.error ?? t('detail.unknownParseError') }}</p>
            <NButton v-if="item.file" size="small" secondary @click="retryItem(item)">
              <template #icon><Icon name="refresh" :size="13" /></template>
              {{ t('common.retry') }}
            </NButton>
          </div>
          <div v-else-if="item.status !== 'done'" class="notice">
            {{ t('detail.parsingNow') }}
            <br />
            <span style="font-size: 12px; color: var(--text-faint)">{{
              t('detail.parsingHint')
            }}</span>
          </div>
          <div v-else-if="corruptRawText" class="notice">
            <span class="notice-title">{{ t('detail.corruptTitle') }}</span>
            <p class="err-message">{{ corruptHint }}</p>
          </div>
          <div v-else class="notice">
            {{ t('detail.noMetadata') }}
            <ul v-if="item.raw.hints?.length" class="hints">
              <li v-for="h in item.raw.hints" :key="h">{{ h }}</li>
            </ul>
          </div>

          <div v-if="item.status === 'done' || item.status === 'error'" class="section">
            <div class="section-title">{{ t('detail.tags') }}</div>
            <div class="tag-editor">
              <div v-for="tag in currentTags" :key="tag" class="tag-chip">
                <button
                  type="button"
                  class="tag-name"
                  :title="t('detail.tagFilter')"
                  @click="filterTag(tag)"
                >
                  {{ tag }}
                </button>
                <button
                  type="button"
                  class="tag-del"
                  :title="t('detail.tagRemove')"
                  :aria-label="t('detail.tagRemove')"
                  @click="removeTag(tag)"
                >
                  <Icon name="x" :size="10" :stroke="2.4" />
                </button>
              </div>
              <NAutoComplete
                v-model:value="tagInput"
                size="small"
                :options="tagSuggestions"
                :placeholder="t('detail.tagAdd')"
                :get-show="() => tagSuggestions.length > 0"
                blur-after-select
                @select="addTag"
                @keyup.enter="addTag()"
              />
            </div>
          </div>

          <div v-if="showJsonTabs" class="section">
            <NTabs v-model:value="tab" type="segment" size="small" animated>
              <NTabPane v-if="item.raw.parameters" name="raw" :tab="t('detail.tabRaw')">
                <pre class="json-pre">{{ item.raw.parameters }}</pre>
                <div style="display: flex; gap: 8px; margin-top: 10px">
                  <NButton
                    size="tiny"
                    secondary
                    @click="copy(item.raw.parameters, t('detail.tabRaw'))"
                  >
                    <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                  </NButton>
                </div>
              </NTabPane>
              <NTabPane v-if="item.raw.prompt" name="prompt" :tab="t('detail.tabPrompt')">
                <pre class="json-pre">{{ jsonText }}</pre>
                <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center">
                  <NButton
                    size="tiny"
                    secondary
                    @click="copy(item.raw.prompt, t('detail.tabPrompt'))"
                  >
                    <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                  </NButton>
                  <NButton
                    size="tiny"
                    secondary
                    @click="downloadJson(item.raw.prompt, 'prompt.json')"
                  >
                    <template #icon><Icon name="download" :size="13" /></template
                    >{{ t('common.download') }}
                  </NButton>
                  <label class="pretty-toggle">
                    <NSwitch v-model:value="prettyJson" size="small" />
                    {{ t('detail.prettyJson') }}
                  </label>
                </div>
              </NTabPane>
              <NTabPane
                v-if="item.raw.source !== 'a1111' && item.raw.source !== 'fooocus'"
                name="workflow"
                :tab="t('detail.tabWorkflow')"
              >
                <pre class="json-pre">{{ jsonText }}</pre>
                <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center">
                  <NButton
                    size="tiny"
                    secondary
                    @click="copy(item.raw.workflow, t('detail.tabWorkflow'))"
                  >
                    <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                  </NButton>
                  <NButton
                    size="tiny"
                    secondary
                    :disabled="!item.raw.workflow"
                    @click="downloadJson(item.raw.workflow, 'workflow.json')"
                  >
                    <template #icon><Icon name="download" :size="13" /></template
                    >{{ t('common.download') }}
                  </NButton>
                  <label class="pretty-toggle">
                    <NSwitch v-model:value="prettyJson" size="small" />
                    {{ t('detail.prettyJson') }}
                  </label>
                </div>
                <p style="margin: 8px 0 0; font-size: 11.5px; color: var(--text-faint)">
                  {{ t('detail.workflowHint') }}
                </p>
              </NTabPane>
            </NTabs>
          </div>

          <p class="kbd-hint">{{ t('detail.kbdHint') }}</p>
        </div>
      </div>
    </div>
    <input
      ref="reattachInput"
      type="file"
      accept=".png,.jpg,.jpeg,.webp"
      hidden
      @change="onReattachFile"
    />
  </NDrawer>
</template>
