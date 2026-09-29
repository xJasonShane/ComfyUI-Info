<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDrawer, NTabPane, NTabs, useMessage } from 'naive-ui'
import type { ImageItem } from '../types'
import type { SamplerInfo } from '../types'
import Icon from './Icon.vue'
import { baseName, copyText, downloadText, humanBytes } from '../lib/utils'
import { retryItem } from '../composables/store'

const props = defineProps<{ item: ImageItem | null }>()
const show = defineModel<boolean>('show', { default: false })
const message = useMessage()

const isNarrow = ref(window.innerWidth < 960)
const onResize = () => {
  isNarrow.value = window.innerWidth < 960
}
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const drawerWidth = computed(() => (isNarrow.value ? '100%' : 940))

const p = computed(() => props.item?.params)

const tab = ref('prompt')
watch(
  () => props.item?.id,
  () => {
    tab.value = props.item?.source === 'a1111' ? 'raw' : 'prompt'
  },
)

const generalRows = computed<[string, string][]>(() => {
  const params = p.value
  const rows: [string, string][] = []
  if (!params) return rows
  if (params.models.length) rows.push(['模型', params.models.join(' + ')])
  if (params.width && params.height) {
    let s = `${params.width} × ${params.height}`
    if (params.batch && params.batch > 1) s += `，每批 ${params.batch} 张`
    rows.push(['出图尺寸', s])
  }
  if (params.nodeCount) rows.push(['工作流节点', `${params.nodeCount} 个`])
  return rows
})

const sampler = computed<SamplerInfo | undefined>(() => p.value?.samplers?.[0])

const samplerRows = computed<[string, string][]>(() => {
  const s = sampler.value
  const rows: [string, string][] = []
  if (!s) return rows
  if (s.sampler) rows.push(['采样器', s.sampler])
  if (s.scheduler) rows.push(['调度器', s.scheduler])
  if (s.steps != null) rows.push(['步数', String(s.steps)])
  if (s.cfg != null) rows.push(['CFG', String(s.cfg)])
  if (s.seed) rows.push(['种子', s.seed])
  if (s.denoise != null) rows.push(['重绘幅度', String(s.denoise)])
  return rows
})

function stageText(s: SamplerInfo): string {
  const parts = [
    `steps ${s.steps ?? '-'}`,
    `cfg ${s.cfg ?? '-'}`,
    `seed ${s.seed ?? '-'}`,
    `denoise ${s.denoise ?? '-'}`,
    s.sampler ? `采样 ${s.sampler}` : '',
  ].filter(Boolean)
  return `#${s.nodeId} ${s.classType} ｜ ${parts.join(' · ')}`
}

const positiveText = computed(() => p.value?.positive.join('\n') ?? '')
const negativeText = computed(() => p.value?.negative.join('\n') ?? '')

const jsonText = computed(() => {
  if (!props.item) return ''
  if (tab.value === 'workflow') return props.item.raw.workflow ?? '（此图未内嵌 UI 工作流）'
  return props.item.raw.prompt ?? ''
})

async function copy(value: string | undefined, label: string) {
  if (!value) return
  const ok = await copyText(value)
  if (ok) message.success(`${label}已复制`)
  else message.error('复制失败，请手动选择文本复制')
}

function downloadJson(text: string | undefined, suffix: string) {
  if (!props.item || !text) return
  downloadText(`${baseName(props.item.name)}.${suffix}`, text)
}
</script>

<template>
  <NDrawer v-model:show="show" :width="drawerWidth" placement="right">
    <div v-if="item" class="detail">
      <div class="detail-view">
        <img :src="item.url" :alt="item.name" />
      </div>

      <div class="detail-panel">
        <div class="fileline">
          <span style="flex: 1">{{ item.name }}</span>
          <span>{{ humanBytes(item.size) }}</span>
          <NButton size="tiny" quaternary circle @click="show = false">
            <template #icon><Icon name="x" :size="13" /></template>
          </NButton>
        </div>

        <template v-if="p">
          <div class="section">
            <div class="section-title">生成参数</div>
            <dl class="kv">
              <template v-for="([k, v], i) in generalRows" :key="i">
                <dt>{{ k }}</dt>
                <dd>{{ v }}</dd>
              </template>
            </dl>
          </div>

          <div v-if="samplerRows.length" class="section">
            <div class="section-title">
              <span>采样参数<template v-if="p.samplers.length > 1">（{{ p.samplers.length }} 阶段）</template></span>
            </div>
            <dl v-if="p.samplers.length === 1" class="kv">
              <template v-for="([k, v], i) in samplerRows" :key="i">
                <dt>{{ k }}</dt>
                <dd>{{ v }}</dd>
              </template>
            </dl>
            <div v-else>
              <div v-for="s in p.samplers" :key="s.nodeId" class="stage-row">
                <span class="txt">{{ stageText(s) }}</span>
              </div>
            </div>
          </div>

          <div v-if="p.loras.length" class="section">
            <div class="section-title">LoRA（{{ p.loras.length }}）</div>
            <div v-for="l in p.loras" :key="l.name" class="stage-row">
              <span class="tag">LoRA</span>
              <span class="txt">
                {{ l.name }}（模型强度 {{ l.strengthModel ?? '-' }} / 文本强度 {{ l.strengthClip ?? '-' }}{{ l.hash ? ` · ${l.hash}` : '' }}）
              </span>
            </div>
          </div>

          <div v-if="positiveText" class="section">
            <div class="section-title">
              <span>正向提示词</span>
              <NButton size="tiny" quaternary @click="copy(positiveText, '正向提示词')">
                <template #icon><Icon name="copy" :size="13" /></template>
                复制
              </NButton>
            </div>
            <pre class="prompt-text">{{ positiveText }}</pre>
          </div>

          <div v-if="negativeText" class="section">
            <div class="section-title">
              <span>负向提示词</span>
              <NButton size="tiny" quaternary @click="copy(negativeText, '负向提示词')">
                <template #icon><Icon name="copy" :size="13" /></template>
                复制
              </NButton>
            </div>
            <pre class="prompt-text">{{ negativeText }}</pre>
          </div>

          <div class="section">
            <NTabs v-model:value="tab" type="segment" size="small" animated>
              <template v-if="item.source === 'a1111'">
                <NTabPane name="raw" tab="原始参数">
                  <pre class="json-pre">{{ item.raw.parameters }}</pre>
                  <div style="display: flex; gap: 8px; margin-top: 10px">
                    <NButton size="tiny" secondary @click="copy(item.raw.parameters, '参数文本')">
                      <template #icon><Icon name="copy" :size="13" /></template>复制
                    </NButton>
                  </div>
                </NTabPane>
              </template>
              <template v-else>
                <NTabPane name="prompt" tab="Prompt JSON">
                  <pre class="json-pre">{{ jsonText }}</pre>
                  <div style="display: flex; gap: 8px; margin-top: 10px">
                    <NButton size="tiny" secondary @click="copy(item.raw.prompt, 'Prompt JSON')">
                      <template #icon><Icon name="copy" :size="13" /></template>复制
                    </NButton>
                    <NButton size="tiny" secondary @click="downloadJson(item.raw.prompt, 'prompt.json')">
                      <template #icon><Icon name="download" :size="13" /></template>下载
                    </NButton>
                  </div>
                </NTabPane>
                <NTabPane name="workflow" tab="UI 工作流">
                  <pre class="json-pre">{{ jsonText }}</pre>
                  <div style="display: flex; gap: 8px; margin-top: 10px">
                    <NButton size="tiny" secondary @click="copy(item.raw.workflow, 'UI 工作流 JSON')">
                      <template #icon><Icon name="copy" :size="13" /></template>复制
                    </NButton>
                    <NButton
                      size="tiny"
                      secondary
                      :disabled="!item.raw.workflow"
                      @click="downloadJson(item.raw.workflow, 'workflow.json')"
                    >
                      <template #icon><Icon name="download" :size="13" /></template>下载
                    </NButton>
                  </div>
                  <p style="margin: 8px 0 0; font-size: 11.5px; color: var(--text-faint)">
                    下载的 workflow.json 可直接拖入 ComfyUI 画布恢复整个工作流。
                  </p>
                </NTabPane>
              </template>
            </NTabs>
          </div>
        </template>

        <div v-else-if="item.status === 'error'" class="notice">
          <span class="notice-title">解析失败</span>
          <p class="err-message">{{ item.error ?? '读取图片元数据时发生未知错误' }}</p>
          <NButton size="small" secondary @click="retryItem(item)">
            <template #icon><Icon name="refresh" :size="13" /></template>
            重试
          </NButton>
        </div>
        <div v-else-if="item.status !== 'done'" class="notice">
          正在解析元数据…
          <br />
          <span style="font-size: 12px; color: var(--text-faint)">稍等片刻，参数马上出来</span>
        </div>
        <div v-else class="notice">
          未检测到 ComfyUI / A1111 生成元数据
          <ul v-if="item.raw.hints?.length" class="hints">
            <li v-for="h in item.raw.hints" :key="h">{{ h }}</li>
          </ul>
        </div>
      </div>
    </div>
  </NDrawer>
</template>
