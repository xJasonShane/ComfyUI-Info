<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ImageItem } from '../types'
import { shortModel } from '../lib/utils'
import Icon from './Icon.vue'

const props = defineProps<{ item: ImageItem; index: number; selected?: boolean }>()
const emit = defineEmits<{ open: []; remove: []; 'select-toggle': []; 'select-range': [] }>()

const broken = ref(false)

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
  return 'var(--gray-src)'
})

const srcLabel = computed(() => {
  if (props.item.status === 'error') return '解析失败'
  if (props.item.status !== 'done') return '解析中'
  if (props.item.source === 'comfyui') return 'ComfyUI'
  if (props.item.source === 'a1111') return 'A1111'
  return '无元数据'
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
    class="card"
    :class="{ 'card-error': item.status === 'error', 'card-selected': selected }"
    :style="{ '--i': index }"
    role="button"
    tabindex="0"
    :data-item-id="item.id"
    :aria-label="`${item.name}，查看详情`"
    :title="item.status === 'error' ? `${displayPath}（${item.error ?? '解析失败'}）` : displayPath"
    @click="onClick"
    @keydown.enter.exact.prevent="$emit('open')"
    @keydown.space.exact.prevent="$emit('open')"
    @keydown.ctrl.space.prevent="$emit('select-toggle')"
    @keydown.meta.space.prevent="$emit('select-toggle')"
  >
    <img
      v-if="!broken && !item.detached && !item.metaOnly"
      :src="item.url"
      loading="lazy"
      alt=""
      @error="broken = true"
    />
    <div v-else-if="item.metaOnly" class="archived">
      <Icon name="file-text" :size="20" :stroke="1.8" />
      <span>参数文件</span>
      <span class="tip">无预览图</span>
    </div>
    <div v-else-if="item.detached" class="archived">
      <Icon name="image" :size="20" :stroke="1.8" />
      <span>已存档</span>
      <span class="tip">重新拖入原文件可回挂</span>
    </div>
    <div v-else class="broken">无法预览</div>
    <div class="src" :style="{ '--src-color': srcColor }"><i />{{ srcLabel }}</div>
    <button
      class="card-check"
      :class="{ on: selected }"
      type="button"
      tabindex="-1"
      :title="selected ? '取消选中' : '选中'"
      :aria-pressed="!!selected"
      aria-label="选中这张图片"
      @click.stop.prevent="$emit('select-toggle')"
    />
    <button
      class="card-remove"
      type="button"
      title="从列表移除"
      aria-label="从列表移除这张图片"
      @click.stop="$emit('remove')"
    >
      <Icon name="x" :size="12" :stroke="2.4" />
    </button>
    <div v-if="modelShort || dims" class="veil">
      <span class="model">{{ modelShort }}</span>
      <span class="dims">{{ dims }}</span>
    </div>
  </div>
</template>
