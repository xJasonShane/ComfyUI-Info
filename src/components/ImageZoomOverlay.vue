<script setup lang="ts">
/**
 * 详情大图放大遮罩（D3 自 DetailDrawer 迁出）：滚轮以光标为锚缩放 / 拖拽平移 /
 * 双击复位 / 键盘 + - 0 缩放。挂载即接管焦点（A7）——Tab 不穿越到遮罩下方，
 * Esc 先退放大再轮到抽屉的关闭快捷键；适配视图下的无拖动点击关闭（原语义）。
 */
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { t } from '../locales'

const props = defineProps<{ src: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()

const ZOOM_MAX = 12
const overlayRef = ref<HTMLElement | null>(null)
const zoomScale = ref(1)
const pan = ref({ x: 0, y: 0 })
const panning = ref(false)
/** 本轮按下的指针是否移动过：区分「拖拽平移」与「点击关闭」，避免平移松手误关 */
let dragMoved = false
let lastX = 0
let lastY = 0

function resetZoom() {
  zoomScale.value = 1
  pan.value = { x: 0, y: 0 }
}

onMounted(() => {
  requestAnimationFrame(() => overlayRef.value?.focus())
})

const zoomStyle = computed(
  () => `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoomScale.value})`,
)

/** 缩放并锚定指定视口点：保持锚点下的图像点不动（布局空间坐标 q 按 oldS 反解） */
function zoomAt(newS: number, anchorX: number, anchorY: number) {
  const oldS = zoomScale.value
  newS = Math.min(ZOOM_MAX, Math.max(1, newS))
  if (newS === oldS) return
  const overlay = overlayRef.value
  if (!overlay) return
  const rect = overlay.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const qx = (anchorX - cx - pan.value.x) / oldS
  const qy = (anchorY - cy - pan.value.y) / oldS
  pan.value = { x: pan.value.x + (oldS - newS) * qx, y: pan.value.y + (oldS - newS) * qy }
  zoomScale.value = newS
  if (newS === 1) resetZoom() // 回到适配视图时归零平移，避免残留偏移
}

function onZoomWheel(e: WheelEvent) {
  // 指数步进：滚轮力度在不同浏览器 / 触控板间差异大，比例缩放对两类设备手感一致
  zoomAt(zoomScale.value * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
}

/** F10：+ / - 键以视口中心为锚步进缩放 */
function zoomStep(factor: number) {
  const rect = overlayRef.value?.getBoundingClientRect()
  if (!rect) return
  zoomAt(zoomScale.value * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    zoomStep(1.25)
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    zoomStep(0.8)
  } else if (e.key === '0') {
    e.preventDefault()
    resetZoom()
  }
}

function onZoomEsc(e: KeyboardEvent) {
  e.stopPropagation()
  emit('close')
}

function onZoomPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  panning.value = true
  dragMoved = false
  lastX = e.clientX
  lastY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onZoomPointerMove(e: PointerEvent) {
  if (!panning.value) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true
  lastX = e.clientX
  lastY = e.clientY
  if (zoomScale.value > 1) pan.value = { x: pan.value.x + dx, y: pan.value.y + dy }
}

function onZoomPointerUp(e: PointerEvent) {
  if (!panning.value) return
  panning.value = false
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // 指针捕获已随元素移除等情况释放，忽略
  }
  // 适配视图下的无拖动点击保持原「点击关闭」语义；放大态的点击 / 平移松手不关闭
  if (zoomScale.value === 1 && !dragMoved) emit('close')
}

function onZoomDblClick() {
  if (zoomScale.value > 1) resetZoom()
}
</script>

<template>
  <div
    ref="overlayRef"
    class="img-zoom"
    :class="{ grab: zoomScale > 1, grabbing: panning }"
    role="button"
    tabindex="-1"
    :aria-label="zoomScale > 1 ? t('detail.zoomHint') : t('detail.zoomClose')"
    @wheel.prevent="onZoomWheel"
    @pointerdown="onZoomPointerDown"
    @pointermove="onZoomPointerMove"
    @pointerup="onZoomPointerUp"
    @pointercancel="onZoomPointerUp"
    @dblclick="onZoomDblClick"
    @keydown.esc.stop="onZoomEsc"
    @keydown="onKeydown"
  >
    <img :src="props.src" :alt="props.alt" :style="{ transform: zoomStyle }" draggable="false" />
    <span v-if="zoomScale > 1" class="zoom-level">{{ Math.round(zoomScale * 100) }}%</span>
    <button
      v-if="zoomScale > 1"
      class="zoom-close"
      type="button"
      :aria-label="t('detail.zoomClose')"
      :title="t('detail.zoomClose')"
      @pointerdown.stop
      @click.stop="emit('close')"
    >
      <Icon name="x" :size="15" />
    </button>
  </div>
</template>
