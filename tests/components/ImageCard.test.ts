// @vitest-environment happy-dom
/**
 * ImageCard 组件测试（E3）：存档缩略图渲染（F2）、嵌套按钮键盘语义（P0-A2 回归）、
 * 事件 emit。happy-dom 环境 + 真实 store 模块（经 restoreArchived 建档，保证
 * liveIds / detached 语义与线上一致）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ImageCard from '../../src/components/ImageCard.vue'
import { clearAll, restoreArchived, store } from '../../src/composables/store'
import type { PersistRecord } from '../../src/lib/persist'
import type { ImageItem } from '../../src/types'

vi.stubGlobal(
  'URL',
  class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:thumb-test')
    static override revokeObjectURL = vi.fn()
  },
)

const rec = (over: Partial<PersistRecord>): PersistRecord => ({
  key: 'a.png|1|1000',
  name: 'a.png',
  path: 'a.png',
  size: 1,
  mtime: 1000,
  status: 'done',
  source: 'comfyui',
  raw: { source: 'comfyui' },
  savedAt: 1,
  ...over,
})

function mountCard(item: ImageItem) {
  return mount(ImageCard, { props: { item, index: 0 } })
}

beforeEach(() => {
  // clearAll 一并重置模块级账本（seenKeys / detachedByKey / itemsByIdentityKey），
  // 只清 items 数组会让下一用例的同身份存档被去重合并（638e2b8 起的身份去重语义）
  clearAll()
})

describe('ImageCard', () => {
  it('存档项以内嵌缩略图兜底渲染（F2）；无缩略图时保持占位', async () => {
    // 两张卡用不同路径：身份键是位置身份（identity:path），同路径存档会被去重合并成一张
    restoreArchived([
      rec({
        key: 'k-arch',
        name: 'with-thumb.png',
        path: 'with-thumb.png',
        thumbB64: btoa('jpeg-bytes'),
      }),
      rec({ key: 'k-plain', name: 'plain.png', path: 'plain.png' }),
    ])
    const [withThumb, plain] = store.items

    const w1 = mountCard(withThumb!)
    await w1.vm.$nextTick()
    expect(withThumb!.thumb).toBe('blob:thumb-test')
    expect(w1.find('img').exists()).toBe(true)
    expect(w1.find('img').attributes('src')).toBe('blob:thumb-test')

    const w2 = mountCard(plain!)
    await w2.vm.$nextTick()
    expect(w2.find('img').exists()).toBe(false)
    expect(w2.find('.archived').exists()).toBe(true)
  })

  it('Enter 打开详情；内层移除按钮的 Enter 不再冒泡成打开（P0-A2 回归）', async () => {
    restoreArchived([rec({ key: 'k1' })])
    const wrapper = mountCard(store.items[0]!)
    await wrapper.vm.$nextTick()

    await wrapper.find('.card').trigger('keydown.enter')
    expect(wrapper.emitted('open')).toHaveLength(1)

    // 焦点在内层移除按钮上按 Enter：按钮的 keydown.stop 阻断冒泡，click 语义触发 remove
    await wrapper.find('.card-remove').trigger('keydown.enter')
    expect(wrapper.emitted('open')).toHaveLength(1) // 未新增
    await wrapper.find('.card-remove').trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('点击卡片打开，Ctrl/⌘+点击切换选中，星标按钮切换收藏', async () => {
    restoreArchived([rec({ key: 'k2' })])
    const wrapper = mountCard(store.items[0]!)
    await wrapper.find('.card').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
    await wrapper.find('.card').trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select-toggle')).toHaveLength(1)
    await wrapper.find('.card-fav').trigger('click')
    expect(wrapper.emitted('toggle-fav')).toHaveLength(1)
  })
})
