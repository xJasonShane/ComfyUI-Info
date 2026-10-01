<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NDropdown, NInput, NPopconfirm, NPopover, NSelect, NTooltip, useMessage } from 'naive-ui'
import Icon from './Icon.vue'
import StatsDrawer from './StatsDrawer.vue'
import {
  addFiles,
  clearAll,
  filteredItems,
  forgetRescanHandle,
  modelOptions,
  parsing,
  rescanDirectory,
  scanProgress,
  setRescanHandle,
  sortOptions,
  sourceOptions,
  store,
  toggleDark,
} from '../composables/store'
import { buildExportCsv, buildExportJson, buildWorkflowZip } from '../lib/export'
import { collectDirectoryFiles, pickDirectory, supportsDirectoryPicker } from '../lib/fs'
import { downloadBinary, downloadText } from '../lib/utils'

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const message = useMessage()
// Chromium 系走 File System Access 选择器（可记住目录、一键重扫），其余回退 webkitdirectory
const fsPickSupported = supportsDirectoryPicker()
const scanning = ref(false)
const showStats = ref(false)

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
    // 分批入列：遍历期间解析已并行开跑；总数为 0 表示目录里没有图片文件（未加入任何项）
    const count = await collectDirectoryFiles(handle, addFiles)
    if (!count) {
      message.warning(`目录「${handle.name}」中没有找到图片文件`)
      return
    }
    await setRescanHandle(handle)
  } finally {
    scanning.value = false
  }
}

async function onRescan() {
  const added = await rescanDirectory()
  if (added === null) {
    message.warning('未能获得目录读取权限，无法重扫')
    return
  }
  // 大目录遍历期间解析可能已全部完成，此时 parsing 为 false 但确有新增，以新增计数为准
  if (added > 0 || parsing.value) message.success(`正在重新扫描「${store.rescanName}」…`)
  else message.info(`「${store.rescanName}」没有新增图片，列表保持不变`)
}

function onForgetRescan() {
  forgetRescanHandle()
  message.success('已不再记住该目录')
}

const exportOptions = [
  { label: '导出 JSON', key: 'json' },
  { label: '导出 CSV (Excel)', key: 'csv' },
  { label: '导出工作流 (ZIP)', key: 'zip' },
]

const exporting = ref(false)

async function exportAs(key: string | number) {
  // 只导出已出结果的项（done / error）；扫描中导出的筛选结果必然缺图，明确告知而不是静默无反应
  if (parsing.value) {
    message.warning('扫描仍在进行，请等扫描完成后再导出')
    return
  }
  const items = filteredItems.value.filter((i) => i.status === 'done' || i.status === 'error')
  if (!items.length) return
  exporting.value = true
  try {
    // 先让按钮 loading 渲染出来，再执行同步的打包计算
    await new Promise((r) => setTimeout(r, 30))
    const stamp = new Date().toISOString().slice(0, 10)
    if (key === 'csv') downloadText(`comfyui-info-${stamp}.csv`, buildExportCsv(items), 'text/csv')
    else if (key === 'zip') {
      const zip = buildWorkflowZip(items)
      if (zip) downloadBinary(`comfyui-info-workflows-${stamp}.zip`, zip)
    } else downloadText(`comfyui-info-${stamp}.json`, buildExportJson(items))
    message.success(`已导出 ${items.length} 项`)
  } finally {
    exporting.value = false
  }
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
    <NButton
      size="small"
      secondary
      :loading="scanning"
      :title="
        fsPickSupported
          ? '选择目录（将记住该目录，可一键重扫增量更新）'
          : '选择目录（递归扫描子文件夹）'
      "
      @click="onPickFolder"
    >
      <template #icon><Icon name="folder-plus" /></template>
      添加文件夹
    </NButton>
    <NTooltip v-if="store.rescanName">
      <template #trigger>
        <NButton size="small" secondary @click="onRescan">
          <template #icon><Icon name="refresh" /></template>
          重扫
        </NButton>
      </template>
      重新扫描记住的目录「{{ store.rescanName }}」，只添加新文件，已有图片按指纹回挂去重
    </NTooltip>
    <NPopconfirm v-if="store.rescanName" @positive-click="onForgetRescan">
      <template #trigger>
        <NButton size="small" quaternary aria-label="不再记住该目录" title="不再记住该目录">
          <template #icon><Icon name="x" /></template>
        </NButton>
      </template>
      确定不再记住目录「{{ store.rescanName }}」？
    </NPopconfirm>
    <NDropdown
      v-if="store.items.length > 0"
      trigger="click"
      :options="exportOptions"
      @select="exportAs"
    >
      <NButton size="small" secondary :loading="exporting" :disabled="exporting || filteredItems.length === 0">
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
          确定清空当前已加载的全部图片？已持久化的历史记录会一并清除。
        </NPopconfirm>
      </template>
      清空列表
    </NTooltip>

    <NPopover trigger="hover" placement="bottom-end" :style="{ maxWidth: '300px' }">
      <template #trigger>
        <NInput
          v-model:value="store.search"
          size="small"
          round
          clearable
          placeholder="搜索提示词 / 模型 / 种子（悬停看语法）"
          style="width: 230px"
        >
          <template #prefix><Icon name="search" :size="14" /></template>
        </NInput>
      </template>
      <div class="search-help">
        <b>搜索语法</b>
        <p><code>model:xxx</code> 按模型名筛选</p>
        <p><code>lora:xxx</code> 按 LoRA 名称或哈希</p>
        <p><code>seed:123</code> 按种子（支持片段）</p>
        <p><code>path:目录</code> 按相对路径</p>
        <p>多个条件用空格分隔，全部满足才命中；普通关键词匹配提示词 / 文件名 / 路径</p>
      </div>
    </NPopover>

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

    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NButton
          size="small"
          quaternary
          circle
          aria-label="生成统计"
          title="生成统计"
          @click="showStats = true"
        >
          <template #icon><Icon name="chart" /></template>
        </NButton>
      </template>
      按模型 / LoRA / 采样器聚合使用频次
    </NTooltip>

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

    <StatsDrawer v-model:show="showStats" />

    <input
      ref="fileInput"
      type="file"
      accept=".png,.jpg,.jpeg,.webp,.json,.txt"
      multiple
      hidden
      @change="onPick"
    />
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onPick" />
  </header>
</template>
