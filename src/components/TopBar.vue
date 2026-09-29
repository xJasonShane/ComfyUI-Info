<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput, NPopconfirm, NSelect, NTooltip } from 'naive-ui'
import Icon from './Icon.vue'
import {
  addFiles,
  clearAll,
  modelOptions,
  parsing,
  scanProgress,
  sourceOptions,
  store,
  toggleDark,
} from '../composables/store'

const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)

function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) addFiles(Array.from(input.files))
  input.value = ''
}

function onPickDir(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) addFiles(Array.from(input.files))
  input.value = ''
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
    <NTooltip v-if="store.items.length > 0">
      <template #trigger>
        <NPopconfirm @positive-click="clearAll">
          <template #trigger>
            <NButton size="small" quaternary type="error">
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

    <NButton size="small" quaternary circle @click="toggleDark" :title="store.dark ? '切换浅色' : '切换深色'">
      <template #icon><Icon :name="store.dark ? 'sun' : 'moon'" /></template>
    </NButton>

    <div v-if="parsing" class="scan-progress">
      <i :style="{ width: scanProgress + '%' }" />
    </div>

    <input ref="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden @change="onPickImages" />
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onPickDir" />
  </header>
</template>
