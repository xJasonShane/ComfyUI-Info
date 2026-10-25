import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { readJSON, writeJSON } from '../lib/prefs'

/** 统计抽屉显隐（TopBar 按钮 / App 的 Esc 全局键共用一份状态） */
export const statsVisible = ref(false)

/** 模型库抽屉显隐（F4，TopBar 按钮 / App 的 Esc 全局键共用一份状态） */
export const modelsVisible = ref(false)

/** 快捷键帮助面板显隐（FEAT-6）：`?`、顶栏帮助按钮与 App 全局 Esc 共用 */
export const shortcutsVisible = ref(false)

/**
 * 随机抽一张的请求信号：TopBar 按钮自增计数，App watch 后从当前筛选结果
 * 随机打开详情。计数信号而非回调注册——与 statsVisible 同一「共享 UI 状态」模式
 */
export const randomPickRequest = ref(0)

/** F10：空状态主按钮 → TopBar 隐藏 input 的请求信号（同一计数信号模式） */
export const openFilePickerRequest = ref(0)
export const openFolderPickerRequest = ref(0)

/** 窄屏断点（与 style.css 的移动端断点保持一致） */
const NARROW_QUERY = '(max-width: 959.98px)'

// 同一查询共享一个 MediaQueryList 实例：各抽屉独立注册监听，媒体状态只维护一份
const narrowQuery = window.matchMedia(NARROW_QUERY)

/* ---------- 抽屉宽度：左缘拖拽调节，按抽屉各自记忆（localStorage） ---------- */
const DRAWER_WIDTH_KEY = 'cii:drawer-widths'
const DRAWER_MIN = 420

function loadDrawerWidths(): Record<string, number> {
  const o = readJSON(DRAWER_WIDTH_KEY)
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= DRAWER_MIN) out[k] = Math.round(v)
  }
  return out
}

const drawerWidths = loadDrawerWidths()

function persistDrawerWidth(key: string, w: number) {
  drawerWidths[key] = w
  writeJSON(DRAWER_WIDTH_KEY, drawerWidths)
}

/**
 * 抽屉宽度响应式（DetailDrawer / CompareDrawer / StatsDrawer 共用，按 key 独立记忆）：
 * 窄屏全宽展示；宽屏初始取记忆值（无则默认值），左缘拖拽手柄实时调节，
 * 松手落盘。返回宽度（NDrawer :width 直接可用）与手柄的指针事件处理器。
 */
export function useDrawerWidth(key: string, desktopWidth: number) {
  const isNarrow = ref(narrowQuery.matches)
  const onNarrowChange = (e: MediaQueryListEvent) => {
    isNarrow.value = e.matches
  }
  onMounted(() => narrowQuery.addEventListener('change', onNarrowChange))
  onBeforeUnmount(() => narrowQuery.removeEventListener('change', onNarrowChange))

  const px = ref(drawerWidths[key] ?? desktopWidth)
  const dragging = ref(false)

  // 右缘手柄 → 宽度：抽屉右锚定，宽度 = 视口宽 - 指针 x；下限防收没，上限留出画廊
  const clamp = (v: number) =>
    Math.min(
      Math.max(DRAWER_MIN, Math.round(v)),
      Math.max(DRAWER_MIN + 80, window.innerWidth - 120),
    )

  function onResizerDown(e: PointerEvent) {
    if (isNarrow.value) return
    e.preventDefault() // 拖拽期间不触发文本选择
    dragging.value = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onResizerMove(e: PointerEvent) {
    if (!dragging.value) return
    px.value = clamp(window.innerWidth - e.clientX)
  }

  function onResizerUp(e: PointerEvent) {
    if (!dragging.value) return
    dragging.value = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // 指针捕获已随元素移除等情况释放，忽略
    }
    persistDrawerWidth(key, px.value)
  }

  const width = computed(() => (isNarrow.value ? '100%' : `${px.value}px`))
  return { width, dragging, onResizerDown, onResizerMove, onResizerUp }
}
