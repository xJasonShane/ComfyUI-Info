<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ImageItem } from '../types'
import { shortModel } from '../lib/utils'

const props = defineProps<{ item: ImageItem; index: number }>()
defineEmits<{ open: [] }>()

const broken = ref(false)

const srcColor = computed(() => {
  if (props.item.source === 'comfyui') return 'var(--accent)'
  if (props.item.source === 'a1111') return 'var(--teal)'
  return 'var(--gray-src)'
})

const srcLabel = computed(() => {
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
  <div class="card" :style="{ '--i': index }" :title="item.name" @click="$emit('open')">
    <img v-if="!broken" :src="item.url" loading="lazy" alt="" @error="broken = true" />
    <div v-else class="broken">无法预览</div>
    <div class="src" :style="{ '--src-color': srcColor }"><i />{{ srcLabel }}</div>
    <div v-if="modelShort || dims" class="veil">
      <span class="model">{{ modelShort }}</span>
      <span class="dims">{{ dims }}</span>
    </div>
  </div>
</template>
