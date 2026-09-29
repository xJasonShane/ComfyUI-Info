<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NDropdown, NInput, NPopconfirm, NSelect, NTooltip, useMessage } from 'naive-ui'
import Icon from './Icon.vue'
import {
  addFiles,
  clearAll,
  filteredItems,
  modelOptions,
  parsing,
  scanProgress,
  sortOptions,
  sourceOptions,
  store,
  toggleDark,
} from '../composables/store'
import { buildExportCsv, buildExportJson } from '../lib/export'
import { downloadText } from '../lib/utils'

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const message = useMessage()

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

const exportOptions = [
  { label: '导出 JSON', key: 'json' },
  { label: '导出 CSV (Excel)', key: 'csv' },
]

function exportAs(key: string | number) {
  // 只导出已出结果的项（done / error）；扫描中导出的筛选结果必然缺图，明确告知而不是静默无反应
  if (parsing.value) {
    message.warning('扫描仍在进行，请等扫描完成后再导出')
    return
  }
  const items = filteredItems.value.filter((i) => i.status === 'done' || i.status === 'error')
  if (!items.length) return
  const stamp = new Date().toISOString().slice(0, 10)
  if (key === 'csv') downloadText(`comfyui-info-${stamp}.csv`, buildExportCsv(items), 'text/csv')
  else downloadText(`comfyui-info-${stamp}.json`, buildExportJson(items))
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
        <div class="brand-sub">图片信息查看器</div>
      </div>
    </div>

    <NButton size="small" secondary @click="fileInput?.click()">
      <template #icon><Icon name="image-plus" /></template>
      添加图片
    </NButton>
    <NButton size="small" secondary @click="dirInput?.click()">
      <template #icon><Icon name="folder-plus" /></template>
      添加文件夹
    </NButton>
    <NDropdown
      v-if="store.items.length > 0"
      trigger="click"
      :options="exportOptions"
      @select="exportAs"
    >
      <NButton size="small" secondary :disabled="filteredItems.length === 0">
        <template #icon><Icon name="download" /></template>
        导出
      </NButton>
    </NDropdown>
    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NPopconfirm @positive-click="clearAll">
          <template #trigger>
            <NButton size="small" quaternary type="error" aria-label="清空列表">
              <template #icon><Icon name="trash" /></template>
            </NButton>
          </template>
          确定清空当前已加载的全部图片？
        </NPopconfirm>
      </template>
      清空列表
    </NTooltip>

    <NInput
      v-model:value="store.search"
      size="small"
      round
      clearable
      placeholder="搜索提示词 / 模型 / LoRA / 文件名"
      style="width: 210px"
    >
      <template #prefix><Icon name="search" :size="14" /></template>
    </NInput>

    <NSelect
      v-model:value="store.modelFilter"
      size="small"
      clearable
      filterable
      placeholder="按模型筛选"
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

    <NSelect
      v-model:value="store.sortMode"
      size="small"
      :options="sortOptions"
      :consistent-menu-width="false"
      style="width: 124px"
    />

    <NButton
      size="small"
      quaternary
      circle
      :aria-label="store.dark ? '切换浅色主题' : '切换深色主题'"
      @click="toggleDark"
      :title="store.dark ? '切换浅色' : '切换深色'"
    >
      <template #icon><Icon :name="store.dark ? 'sun' : 'moon'" /></template>
    </NButton>

    <div v-if="parsing" class="scan-progress">
      <i :style="{ width: scanProgress + '%' }" />
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".png,.jpg,.jpeg,.webp"
      multiple
      hidden
      @change="onPick"
    />
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onPick" />
  </header>
</template>
