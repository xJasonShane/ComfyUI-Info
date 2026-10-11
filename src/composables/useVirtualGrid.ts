/**
 * 画廊虚拟滚动（P3 / D3）：按行列窗口渲染，万级列表滚动恒定 DOM 量。
 * 自研行列窗口化：上下 padding 撑起总高度，仅切片可视行（上下各 overscan 3 行），
 * rAF 节流滚动、ResizeObserver 量宽。GRID_GAP 必须与 style.css .grid 的 gap 保持一致，
 * 列数计算才与实际布局吻合；--card-min 由调用方传入（缩略图大小偏好驱动列数）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { ImageItem } from '../types'

/** 与 style.css .grid 的 gap: 13px 保持一致（改 CSS 必须同步这里） */
const GRID_GAP = 13
const OVERSCAN_ROWS = 3
/** 首帧未量得尺寸时先渲染一小页，量到后立即进入窗口化 */
const FIRST_PAGE = 24

export function useVirtualGrid(items: Ref<ImageItem[]>, cardMin: Ref<number>) {
  const galleryRef = ref<HTMLElement | null>(null)
  const galleryWidth = ref(0)
  /** 画廊顶边滚出视口的像素数（未滚到为负，钳到 0 参与 row 计算） */
  const viewTop = ref(0)
  // 视口高度建成响应式（A5）：endRow 的 computed 依赖它，窗口仅垂直方向变化时
  // 也立刻扩展渲染窗口，而不是等到用户滚动才自愈
  const winH = ref(window.innerHeight)
  // 入场动画只在首屏播一次（A6）：虚拟滚动窗口切片随滚动不断挂载新卡片，
  // 每次挂载都播 0.4s 动画会让快速滚动全程闪烁；首次滚动后即关闭
  const animateCards = ref(true)

  const cols = computed(() =>
    Math.max(1, Math.floor((galleryWidth.value + GRID_GAP) / (cardMin.value + GRID_GAP))),
  )
  const rowH = computed(() => {
    if (!galleryWidth.value) return 0
    const cardW = (galleryWidth.value - GRID_GAP * (cols.value - 1)) / cols.value
    return cardW + GRID_GAP
  })
  const totalRows = computed(() => Math.ceil(items.value.length / cols.value))

  const startRow = computed(() =>
    Math.max(0, Math.floor(Math.max(0, viewTop.value) / rowH.value) - OVERSCAN_ROWS),
  )
  const endRow = computed(() =>
    Math.min(
      totalRows.value,
      Math.ceil((Math.max(0, viewTop.value) + winH.value) / rowH.value) + OVERSCAN_ROWS,
    ),
  )
  const visibleItems = computed(() => {
    if (!rowH.value) return items.value.slice(0, FIRST_PAGE)
    return items.value.slice(startRow.value * cols.value, endRow.value * cols.value)
  })
  const topPad = computed(() => startRow.value * rowH.value)
  const bottomPad = computed(() => Math.max(0, (totalRows.value - endRow.value) * rowH.value))

  // 长列表滚深后提供一键回顶（万级图滚回顶部很痛苦）；viewTop 即画廊顶边滚出的像素
  const showBackTop = computed(() => viewTop.value > 600)
  function backToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  let scrollRaf = 0
  function updateViewTop() {
    const el = galleryRef.value
    if (!el) return
    viewTop.value = -el.getBoundingClientRect().top
  }
  function onWinScroll() {
    if (scrollRaf) return
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0
      winH.value = window.innerHeight
      if (animateCards.value) animateCards.value = false
      updateViewTop()
    })
  }
  let resizeObserver: ResizeObserver | null = null
  onMounted(() => {
    updateViewTop()
    window.addEventListener('scroll', onWinScroll, { passive: true })
    window.addEventListener('resize', onWinScroll)
    if (typeof ResizeObserver !== 'undefined' && galleryRef.value) {
      resizeObserver = new ResizeObserver(() => {
        galleryWidth.value = galleryRef.value?.clientWidth ?? 0
        updateViewTop()
      })
      resizeObserver.observe(galleryRef.value)
      galleryWidth.value = galleryRef.value.clientWidth
    }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', onWinScroll)
    window.removeEventListener('resize', onWinScroll)
    resizeObserver?.disconnect()
    if (scrollRaf) cancelAnimationFrame(scrollRaf)
  })
  // 条目数量 / 卡片宽度变化会改变总行数与顶边位置，主动校正窗口
  watch([() => items.value.length, cardMin], () => updateViewTop())

  return {
    galleryRef,
    visibleItems,
    topPad,
    bottomPad,
    showBackTop,
    backToTop,
    updateViewTop,
    animateCards,
  }
}
