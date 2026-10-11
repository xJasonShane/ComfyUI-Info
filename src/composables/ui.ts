import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/** 窄屏断点（与 style.css 的移动端断点保持一致） */
const NARROW_QUERY = '(max-width: 959.98px)'

// 同一查询共享一个 MediaQueryList 实例：各抽屉独立注册监听，媒体状态只维护一份
const narrowQuery = window.matchMedia(NARROW_QUERY)

/**
 * 抽屉宽度响应式（DetailDrawer / CompareDrawer / StatsDrawer 共用）：
 * 窄屏全宽展示，宽屏用固定像素宽。
 */
export function useDrawerWidth(desktopWidth: number) {
  const isNarrow = ref(narrowQuery.matches)
  const onNarrowChange = (e: MediaQueryListEvent) => {
    isNarrow.value = e.matches
  }
  onMounted(() => narrowQuery.addEventListener('change', onNarrowChange))
  onBeforeUnmount(() => narrowQuery.removeEventListener('change', onNarrowChange))
  return computed(() => (isNarrow.value ? '100%' : desktopWidth))
}
