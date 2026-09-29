<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ImageItem } from '../types'
import { shortModel } from '../lib/utils'
import Icon from './Icon.vue'

const props = defineProps<{ item: ImageItem; index: number }>()
defineEmits<{ open: []; remove: [] }>()

const broken = ref(false)

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
</script>

<template>
  <div
    class="card"
    :class="{ 'card-error': item.status === 'error' }"
    :style="{ '--i': index }"
    role="button"
    tabindex="0"
    :data-item-id="item.id"
    :aria-label="`${item.name}，查看详情`"
    :title="item.status === 'error' ? `${item.name}（${item.error ?? '解析失败'}）` : item.name"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <img v-if="!broken" :src="item.url" loading="lazy" alt="" @error="broken = true" />
    <div v-else class="broken">无法预览</div>
    <div class="src" :style="{ '--src-color': srcColor }"><i />{{ srcLabel }}</div>
    <button class="card-remove" type="button" title="从列表移除" aria-label="从列表移除这张图片" @click.stop="$emit('remove')">
      <Icon name="x" :size="12" :stroke="2.4" />
    </button>
    <div v-if="modelShort || dims" class="veil">
      <span class="model">{{ modelShort }}</span>
      <span class="dims">{{ dims }}</span>
    </div>
  </div>
</template>
