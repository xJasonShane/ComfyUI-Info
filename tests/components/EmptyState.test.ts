// @vitest-environment happy-dom
/**
 * EmptyState 组件测试（E3）：筛选空态与首用空态两种形态，主按钮触发 ui.ts 请求
 * 信号（F10）。happy-dom 环境。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import EmptyState from '../../src/components/EmptyState.vue'
import { openFilePickerRequest, openFolderPickerRequest } from '../../src/composables/ui'

beforeEach(() => {
  openFilePickerRequest.value = 0
  openFolderPickerRequest.value = 0
})

describe('EmptyState', () => {
  it('首用空态渲染主操作按钮，点击触发选择器请求信号（F10）', async () => {
    const wrapper = mount(EmptyState, { props: { filtered: false, hiddenCount: 0 } })
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    await buttons[0]!.trigger('click')
    expect(openFilePickerRequest.value).toBe(1)
    await buttons[1]!.trigger('click')
    expect(openFolderPickerRequest.value).toBe(1)
  })

  it('筛选空态展示被隐藏数量与一键查看全部', async () => {
    const wrapper = mount(EmptyState, { props: { filtered: true, hiddenCount: 7 } })
    const showAll = wrapper.find('.show-all')
    expect(showAll.exists()).toBe(true)
    await showAll.trigger('click')
    expect(wrapper.emitted('showAll')).toHaveLength(1)
  })
})
