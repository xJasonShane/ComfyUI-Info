<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NDropdown,
  NInput,
  NPopconfirm,
  NPopover,
  NSelect,
  NSlider,
  NSwitch,
  NTooltip,
  useMessage,
} from 'naive-ui'
import Icon from './Icon.vue'
import ModelDrawer from './ModelDrawer.vue'
import SearchBox from './SearchBox.vue'
import StatsDrawer from './StatsDrawer.vue'
import {
  addFiles,
  applyFilterPreset,
  buildArchiveBackup,
  clearAll,
  clearAllDirBookmarks,
  deleteFilterPreset,
  dupeCount,
  favCount,
  filteredItems,
  filterPresets,
  forgetRescanHandle,
  getDirectorySourceId,
  importArchive,
  modelOptions,
  parsing,
  retryPersistence,
  rescanAllDirectories,
  rescanDirectory,
  RESCAN_INTERVALS,
  saveFilterPreset,
  scanProgress,
  setRescanHandle,
  sortOptions,
  sourceOptions,
  store,
  switchRescanTarget,
  toggleDark,
  toggleSafeMode,
} from '../composables/store'
import type { FilterPreset } from '../composables/store'
import { exportItems, exportOptions } from '../lib/export'
import { collectDirectoryFiles, pickDirectory, supportsDirectoryPicker } from '../lib/fs'
import { downloadText } from '../lib/utils'
import { locale, t, toggleLocale } from '../locales'
import {
  modelsVisible,
  openFilePickerRequest,
  openFolderPickerRequest,
  randomPickRequest,
  statsVisible,
} from '../composables/ui'

const fileInput = ref<HTMLInputElement | null>(null)
// F10：空状态主按钮直接触发这里的选择器（计数信号与 randomPickRequest 同模式）
watch(openFilePickerRequest, () => fileInput.value?.click())
watch(openFolderPickerRequest, () => void onPickFolder())
const dirInput = ref<HTMLInputElement | null>(null)
const message = useMessage()
// Chromium 系走 File System Access 选择器（可记住目录、一键重扫），其余回退 webkitdirectory
const fsPickSupported = supportsDirectoryPicker()
const scanning = ref(false)
const persistenceLabel = computed(() => {
  switch (store.persistenceStatus) {
    case 'checking':
      return t('persistence.checking')
    case 'saving':
      return t('persistence.saving')
    case 'error':
      return t('persistence.error')
    case 'unavailable':
      return t('persistence.unavailable')
    default:
      return t('persistence.saved')
  }
})
const persistenceCanRetry = computed(
  () => store.persistenceStatus === 'error' || store.persistenceStatus === 'unavailable',
)
const persistenceTooltip = computed(() => {
  if (store.persistenceStatus === 'unavailable') return t('persistence.unavailableDetail')
  if (store.persistenceError) {
    return t('persistence.errorDetail', { msg: store.persistenceError })
  }
  if (store.persistenceStatus === 'saving') return t('persistence.saving')
  if (store.persistenceStatus === 'checking') return t('persistence.checking')
  return t('persistence.okDetail')
})
// 统计抽屉显隐提升到 ui.ts：App 的全局 Esc（清空选择）需要感知抽屉是否打开
const showStats = statsVisible
// 模型库抽屉（F4）同理
const showModels = modelsVisible

/** webkitRelativePath 仅在目录选择时有值，普通多选为空串——退回 undefined 让去重退化为文件名 */
function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) {
    addFiles(
      Array.from(input.files).map((f) => ({
        file: f,
        path: f.webkitRelativePath || undefined,
      })),
    )
  }
  input.value = ''
}

async function onPickFolder() {
  if (!fsPickSupported) {
    dirInput.value?.click()
    return
  }
  const handle = await pickDirectory()
  if (!handle) return
  scanning.value = true
  try {
    const sourceId = await getDirectorySourceId(handle)
    // 分批入列：遍历期间解析已并行开跑；总数为 0 表示目录里没有图片文件（未加入任何项）
    const count = await collectDirectoryFiles(handle, (files) =>
      addFiles(files.map((file) => ({ ...file, sourceId }))),
    )
    if (!count) {
      message.warning(t('msg.dirEmpty', { name: handle.name }))
      return
    }
    await setRescanHandle(handle, sourceId)
  } finally {
    scanning.value = false
  }
}

async function onRescan() {
  const added = await rescanDirectory()
  if (added === null) {
    message.warning(t('msg.rescanNoPermission'))
    return
  }
  // 大目录遍历期间解析可能已全部完成，此时 parsing 为 false 但确有新增，以新增计数为准
  const name = store.rescanName ?? ''
  if (added > 0 || parsing.value) message.success(t('msg.rescanStarted', { name }))
  else message.info(t('msg.rescanNoNew', { name }))
}

function onForgetRescan() {
  forgetRescanHandle()
  message.success(t('msg.forgetDir'))
}

/* ---------- 多目录书签（FEAT-7）：在记住的目录间切换重扫目标；全部重扫（F3） ---------- */
const dirMenuOptions = computed(() => {
  const names = store.dirBookmarks
  if (!names.length) return []
  return [
    ...names.map((n) => ({ label: n === store.rescanName ? `✓ ${n}` : n, key: `use:${n}` })),
    { type: 'divider' as const, key: 'dir-divider' },
    { label: t('topbar.rescanAll'), key: 'rescan-all' },
    { label: t('topbar.clearBookmarks'), key: 'clear-all' },
  ]
})

async function onRescanAll() {
  const { added, failed } = await rescanAllDirectories()
  if (failed && !added) message.warning(t('msg.rescanNoPermission'))
  else if (added > 0 || parsing.value) message.success(t('msg.rescanAllStarted', { n: added }))
  else message.info(t('msg.rescanAllNone'))
}

async function onDirMenu(key: string | number) {
  const k = String(key)
  if (k === 'clear-all') {
    clearAllDirBookmarks()
    message.success(t('msg.bookmarksCleared'))
    return
  }
  if (k === 'rescan-all') {
    await onRescanAll()
    return
  }
  const name = k.startsWith('use:') ? k.slice(4) : ''
  if (name && switchRescanTarget(name)) await onRescan()
}

const exporting = ref(false)

/** 缩略图大小滑杆的悬浮提示：直接显示像素值 */
const fmtThumb = (v: number) => `${v}px`

/** 自动重扫间隔下拉（响应式，随语言切换刷新标签） */
const intervalOptions = computed(() =>
  RESCAN_INTERVALS.map((v) => ({ label: t('topbar.rescanSecs', { n: v }), value: v })),
)

async function exportAs(key: string | number) {
  // 只导出已出结果的项；扫描中导出的筛选结果必然缺图，明确告知而不是静默无反应
  if (parsing.value) {
    message.warning(t('common.exportWhileParsing'))
    return
  }
  exporting.value = true
  try {
    await exportItems(filteredItems.value, key, 'comfyui-info', message)
  } finally {
    exporting.value = false
  }
}

/* ---------- 存档备份（FEAT-6：导出 / 导入，防清库与跨设备迁移） ---------- */
// 与 exportOptions 同理用 computed：标签在渲染时取值，随界面语言切换刷新
const archiveOptions = computed(() => [
  { label: t('archive.export'), key: 'export' },
  { label: t('archive.import'), key: 'import' },
])

const archiveInput = ref<HTMLInputElement | null>(null)

async function onArchiveMenu(key: string | number) {
  if (key === 'export') {
    const { text, count } = buildArchiveBackup()
    if (!count) {
      message.info(t('msg.archiveEmpty'))
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(`comfyui-info-archive-${stamp}.json`, text)
    message.success(t('msg.archiveExported', { n: count }))
  } else {
    archiveInput.value?.click()
  }
}

async function onImportArchiveFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  try {
    const { n, favs, tags } = await importArchive(await f.text())
    if (n) message.success(t('msg.archiveImported', { n }))
    else message.info(t('msg.archiveAllExists'))
    if (favs) message.success(t('msg.archiveFavsMerged', { n: favs }))
    if (tags) message.success(t('msg.archiveTagsMerged', { n: tags }))
  } catch (err) {
    message.error(
      t('msg.archiveImportFailed', { msg: err instanceof Error ? err.message : String(err) }),
    )
  }
}

/* ---------- 筛选预设：保存 / 应用 / 删除命名筛选组合 ---------- */
const presetName = ref('')

function presetDesc(p: FilterPreset): string {
  const src = sourceOptions.value.find((o) => o.value === p.sourceFilter)?.label ?? ''
  return [src, p.modelFilter ?? '', p.search].filter(Boolean).join(' · ')
}

function applyPreset(name: string) {
  applyFilterPreset(name)
}

function removePreset(name: string) {
  deleteFilterPreset(name)
}

function savePreset() {
  const name = presetName.value.trim()
  if (!name) return
  saveFilterPreset(name)
  presetName.value = ''
  message.success(t('msg.presetSaved', { name }))
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">
        <Icon name="image" :size="19" :stroke="2.2" />
      </div>
      <div>
        <div class="brand-name">ComfyUI·Info</div>
        <div class="brand-sub">{{ t('topbar.subtitle') }}</div>
      </div>
    </div>

    <NButton size="small" secondary @click="fileInput?.click()">
      <template #icon><Icon name="image-plus" /></template>
      {{ t('topbar.addImages') }}
    </NButton>
    <NButton
      size="small"
      secondary
      :loading="scanning"
      :title="fsPickSupported ? t('topbar.pickDirTitleFsa') : t('topbar.pickDirTitlePlain')"
      @click="onPickFolder"
    >
      <template #icon><Icon name="folder-plus" /></template>
      {{ t('topbar.addFolder') }}
    </NButton>
    <NTooltip v-if="store.rescanName">
      <template #trigger>
        <NButton size="small" secondary @click="onRescan">
          <template #icon><Icon name="refresh" /></template>
          {{ t('topbar.rescan') }}
        </NButton>
      </template>
      {{ t('topbar.rescanTooltip', { name: store.rescanName }) }}
    </NTooltip>
    <NTooltip v-if="store.rescanName">
      <template #trigger>
        <NSwitch
          v-model:value="store.autoRescan"
          size="small"
          :aria-label="t('topbar.autoRescanAria')"
        />
      </template>
      {{ t('topbar.autoRescanTooltip', { name: store.rescanName }) }}
    </NTooltip>
    <NSelect
      v-if="store.rescanName && store.autoRescan"
      v-model:value="store.autoRescanInterval"
      size="small"
      :options="intervalOptions"
      :consistent-menu-width="false"
      :aria-label="t('topbar.rescanInterval')"
      style="width: 86px"
    />
    <NDropdown
      v-if="store.dirBookmarks.length"
      trigger="click"
      :options="dirMenuOptions"
      @select="onDirMenu"
    >
      <NButton size="small" secondary :title="t('topbar.dirsTitle')">
        <template #icon><Icon name="folder" /></template>
        {{ t('topbar.dirs') }}
      </NButton>
    </NDropdown>
    <NPopconfirm v-if="store.rescanName" @positive-click="onForgetRescan">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          :aria-label="t('topbar.forgetTitle')"
          :title="t('topbar.forgetTitle')"
        >
          <template #icon><Icon name="x" /></template>
        </NButton>
      </template>
      {{ t('topbar.forgetConfirm', { name: store.rescanName }) }}
    </NPopconfirm>
    <NDropdown
      v-if="store.items.length > 0"
      trigger="click"
      :options="exportOptions"
      @select="exportAs"
    >
      <NButton
        size="small"
        secondary
        :loading="exporting"
        :disabled="exporting || filteredItems.length === 0"
      >
        <template #icon><Icon name="download" /></template>
        {{ t('topbar.export') }}
      </NButton>
    </NDropdown>
    <NDropdown trigger="click" :options="archiveOptions" @select="onArchiveMenu">
      <NButton size="small" secondary :title="t('topbar.archiveTitle')">
        <template #icon><Icon name="archive" /></template>
        {{ t('topbar.archive') }}
      </NButton>
    </NDropdown>
    <NTooltip>
      <template #trigger>
        <NButton
          size="small"
          secondary
          :type="persistenceCanRetry ? 'error' : 'default'"
          :loading="store.persistenceStatus === 'checking' || store.persistenceStatus === 'saving'"
          :disabled="!persistenceCanRetry"
          :aria-label="persistenceCanRetry ? t('persistence.retry') : persistenceLabel"
          @click="retryPersistence"
        >
          <template #icon><Icon :name="persistenceCanRetry ? 'refresh' : 'archive'" /></template>
          {{ persistenceLabel }}
        </NButton>
      </template>
      {{ persistenceTooltip }}
    </NTooltip>
    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NPopconfirm @positive-click="clearAll">
          <template #trigger>
            <NButton size="small" quaternary type="error" :aria-label="t('topbar.clearAll')">
              <template #icon><Icon name="trash" /></template>
            </NButton>
          </template>
          {{ t('topbar.clearAllConfirm') }}
        </NPopconfirm>
      </template>
      {{ t('topbar.clearAll') }}
    </NTooltip>

    <SearchBox />

    <NSelect
      v-model:value="store.modelFilter"
      size="small"
      clearable
      filterable
      :placeholder="t('topbar.modelPlaceholder')"
      :options="modelOptions"
      :consistent-menu-width="false"
      style="width: 170px"
    />

    <NSelect
      v-model:value="store.sourceFilter"
      size="small"
      :options="sourceOptions"
      :consistent-menu-width="false"
      style="width: 140px"
    />

    <NPopover v-if="store.items.length > 0" trigger="click" placement="bottom">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          :aria-label="t('topbar.presets')"
          :title="t('topbar.presets')"
        >
          <template #icon><Icon name="bookmark" :size="15" /></template>
        </NButton>
      </template>
      <div class="preset-pop">
        <div class="preset-head">{{ t('topbar.presets') }}</div>
        <div v-if="filterPresets.length" class="preset-list">
          <div v-for="p in filterPresets" :key="p.name" class="preset-row">
            <button
              type="button"
              class="preset-apply"
              :title="t('topbar.presetApplyTitle', { name: p.name })"
              @click="applyPreset(p.name)"
            >
              <span class="preset-name">{{ p.name }}</span>
              <span class="preset-desc">{{ presetDesc(p) }}</span>
            </button>
            <button
              type="button"
              class="preset-del"
              :title="t('topbar.presetDelete')"
              :aria-label="t('topbar.presetDelete')"
              @click="removePreset(p.name)"
            >
              <Icon name="x" :size="11" :stroke="2.2" />
            </button>
          </div>
        </div>
        <p v-else class="preset-empty">{{ t('topbar.presetEmpty') }}</p>
        <div class="preset-save">
          <NInput
            v-model:value="presetName"
            size="small"
            :placeholder="t('topbar.presetNamePlaceholder')"
            @keydown.enter.prevent="savePreset"
          />
          <NButton size="small" secondary :disabled="!presetName.trim()" @click="savePreset">
            {{ t('topbar.presetSave') }}
          </NButton>
        </div>
      </div>
    </NPopover>

    <NSelect
      v-model:value="store.sortMode"
      size="small"
      :options="sortOptions"
      :consistent-menu-width="false"
      style="width: 124px"
    />

    <NPopover v-if="store.items.length > 0" trigger="click" placement="bottom">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          :aria-label="t('topbar.thumbSize')"
          :title="t('topbar.thumbSize')"
        >
          <template #icon><Icon name="sliders" /></template>
        </NButton>
      </template>
      <div class="thumb-size-pop">
        <span>{{ t('topbar.thumbSize') }}</span>
        <NSlider
          v-model:value="store.thumbSize"
          :min="150"
          :max="420"
          :step="10"
          :format-tooltip="fmtThumb"
          style="width: 150px"
        />
        <span class="thumb-size-val">{{ store.thumbSize }}px</span>
      </div>
    </NPopover>

    <NTooltip v-if="dupeCount > 0">
      <template #trigger>
        <NSwitch
          v-model:value="store.dupeOnly"
          size="small"
          :aria-label="t('topbar.dupeOnlyAria')"
        />
      </template>
      {{ t('topbar.dupeOnlyTooltip') }}
    </NTooltip>

    <NTooltip v-if="favCount > 0">
      <template #trigger>
        <NSwitch v-model:value="store.favOnly" size="small" :aria-label="t('topbar.favOnlyAria')" />
      </template>
      {{ t('topbar.favOnlyTooltip', { n: favCount }) }}
    </NTooltip>

    <NTooltip v-if="filteredItems.length > 0">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          :aria-label="t('topbar.randomPick')"
          :title="t('topbar.randomPickTitle', { n: filteredItems.length })"
          @click="randomPickRequest++"
        >
          <template #icon><Icon name="dices" :size="15" /></template>
        </NButton>
      </template>
      {{ t('topbar.randomPickTitle', { n: filteredItems.length }) }}
    </NTooltip>

    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          :aria-label="t('topbar.models')"
          :title="t('topbar.modelsTooltip')"
          @click="showModels = true"
        >
          <template #icon><Icon name="package" /></template>
        </NButton>
      </template>
      {{ t('topbar.modelsTooltip') }}
    </NTooltip>

    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          :aria-label="t('topbar.stats')"
          :title="t('topbar.stats')"
          @click="showStats = true"
        >
          <template #icon><Icon name="chart" /></template>
        </NButton>
      </template>
      {{ t('topbar.statsTooltip') }}
    </NTooltip>

    <NButton
      size="small"
      quaternary
      circle
      :aria-label="store.safeMode ? t('topbar.safeModeOn') : t('topbar.safeModeOff')"
      :aria-pressed="store.safeMode"
      :title="store.safeMode ? t('topbar.safeModeOn') : t('topbar.safeModeOff')"
      @click="toggleSafeMode"
    >
      <template #icon><Icon :name="store.safeMode ? 'eye-off' : 'eye'" /></template>
    </NButton>

    <NButton
      size="small"
      quaternary
      circle
      :aria-label="store.dark ? t('topbar.themeToLight') : t('topbar.themeToDark')"
      @click="toggleDark"
      :title="store.dark ? t('topbar.themeToLight') : t('topbar.themeToDark')"
    >
      <template #icon><Icon :name="store.dark ? 'sun' : 'moon'" /></template>
    </NButton>

    <NButton
      size="small"
      quaternary
      circle
      :aria-label="t('topbar.localeAria')"
      :title="t('topbar.localeAria')"
      @click="toggleLocale"
    >
      <span style="font-size: 11px; font-weight: 600">{{ locale === 'zh' ? 'EN' : '中' }}</span>
    </NButton>

    <div v-if="parsing" class="scan-progress">
      <i :style="{ width: scanProgress + '%' }" />
    </div>

    <StatsDrawer v-model:show="showStats" />

    <ModelDrawer v-model:show="showModels" />

    <input
      ref="fileInput"
      type="file"
      accept=".png,.jpg,.jpeg,.webp,.json,.txt"
      multiple
      hidden
      @change="onPick"
    />
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onPick" />
    <input
      ref="archiveInput"
      type="file"
      accept=".json,application/json"
      hidden
      @change="onImportArchiveFile"
    />
  </header>
</template>
