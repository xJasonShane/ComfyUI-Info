<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NDrawer, NTabPane, NTabs, NSwitch, useMessage } from 'naive-ui'
import type { ImageItem } from '../types'
import type { SamplerInfo } from '../types'
import Icon from './Icon.vue'
import { baseName, copyText, downloadText, humanBytes } from '../lib/utils'
import { retryItem, ensureItemUrl } from '../composables/store'
import { useDrawerWidth } from '../composables/ui'
import { dateLocale, t } from '../locales'

const props = defineProps<{ item: ImageItem | null }>()
const show = defineModel<boolean>('show', { default: false })
const message = useMessage()

const drawerWidth = useDrawerWidth(940)

const p = computed(() => props.item?.params)

/* ---------- FEAT-8：详情大图点击放大（点遮罩关闭，切图 / 关抽屉自动收起） ---------- */
const zoomed = ref(false)
watch(
  () => props.item?.id,
  () => {
    zoomed.value = false
  },
)
watch(show, (v) => {
  if (!v) zoomed.value = false
})

// P2：详情大图与抽屉浏览同样按需创建预览 URL
watch(
  () => props.item?.id,
  () => {
    if (props.item) ensureItemUrl(props.item)
  },
  { immediate: true },
)

const fileTime = computed(() => {
  if (!props.item) return ''
  return new Date(props.item.mtime).toLocaleString(dateLocale(), {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
})

/** 当前条目上实际可用的 JSON 页签（与模板里各 NTabPane 的渲染条件保持一致） */
function availableTabs(item: ImageItem): string[] {
  const tabs: string[] = []
  if (item.raw.parameters) tabs.push('raw')
  if (item.raw.prompt) tabs.push('prompt')
  if (item.raw.source !== 'a1111') tabs.push('workflow')
  return tabs
}

const tab = ref('prompt')
// 切换图片时保留用户所在页签（如对照多张图的 workflow）；新条目没有该页签时才回退默认
watch(
  () => props.item?.id,
  () => {
    const it = props.item
    if (!it) return
    const tabs = availableTabs(it)
    if (tabs.includes(tab.value)) return
    tab.value = it.source === 'a1111' && tabs.includes('raw') ? 'raw' : (tabs[0] ?? 'prompt')
  },
)

/** 是否渲染 JSON 页签区：有任一原始文本就展示（含「元数据存在但解析失败」的场景） */
const showJsonTabs = computed(() => {
  const it = props.item
  return !!it && !!(it.raw.parameters || it.raw.prompt || it.raw.workflow)
})

/** 元数据文本存在但结构化参数缺失：JSON 损坏 / 无法解析，或仅有 UI 工作流（无 API prompt），与「无元数据」区分开 */
const corruptRawText = computed(() => {
  const it = props.item
  return (
    !!it &&
    it.status === 'done' &&
    !it.params &&
    !!(it.raw.prompt || it.raw.parameters || it.raw.workflow)
  )
})

/** 元数据存在但无结构化参数时的解释文案：区分「仅有 UI 工作流」与「JSON / 参数文本损坏」 */
const corruptHint = computed(() => {
  const it = props.item
  if (!it) return ''
  if (!it.raw.prompt && !it.raw.parameters && it.raw.workflow) {
    return t('detail.corruptUiOnly')
  }
  return it.raw.source === 'comfyui' ? t('detail.corruptJson') : t('detail.corruptText')
})

const generalRows = computed<[string, string][]>(() => {
  const params = p.value
  const rows: [string, string][] = []
  if (!params) return rows
  if (params.models.length) rows.push([t('detail.model'), params.models.join(' + ')])
  if (params.vaes.length) rows.push([t('detail.vae'), params.vaes.join(' + ')])
  if (params.clipSkip !== undefined) rows.push([t('detail.clipSkip'), String(params.clipSkip)])
  if (params.width && params.height) {
    let s = `${params.width} × ${params.height}`
    if (params.batch && params.batch > 1) s += t('detail.perBatch', { n: params.batch })
    rows.push([t('detail.size'), s])
  }
  if (params.upscalers.length) rows.push([t('detail.upscaler'), params.upscalers.join(' + ')])
  if (params.controlNets.length) rows.push([t('detail.controlnet'), params.controlNets.join(' + ')])
  if (params.nodeCount) rows.push([t('detail.nodeCount'), t('detail.nodes', { n: params.nodeCount })])
  return rows
})

const sampler = computed<SamplerInfo | undefined>(() => p.value?.samplers?.[0])

const samplerRows = computed<[string, string][]>(() => {
  const s = sampler.value
  const rows: [string, string][] = []
  if (!s) return rows
  if (s.sampler) rows.push([t('detail.sampler'), s.sampler])
  if (s.scheduler) rows.push([t('detail.scheduler'), s.scheduler])
  if (s.steps != null) rows.push([t('detail.steps'), String(s.steps)])
  if (s.cfg != null) rows.push([t('detail.cfg'), String(s.cfg)])
  if (s.seed) rows.push([t('detail.seed'), s.seed])
  if (s.denoise != null) rows.push([t('detail.denoise'), String(s.denoise)])
  return rows
})

function stageText(s: SamplerInfo): string {
  const parts = [
    `steps ${s.steps ?? '-'}`,
    `cfg ${s.cfg ?? '-'}`,
    `seed ${s.seed ?? '-'}`,
    `denoise ${s.denoise ?? '-'}`,
    s.sampler ? `${t('detail.sampler')} ${s.sampler}` : '',
  ].filter(Boolean)
  return `#${s.nodeId} ${s.classType} ｜ ${parts.join(' · ')}`
}

const positiveText = computed(() => p.value?.positive.join('\n') ?? '')
const negativeText = computed(() => p.value?.negative.join('\n') ?? '')

/* ---------- JSON 页签格式化显示（仅影响展示；复制 / 下载始终使用原文） ---------- */
const prettyJson = ref(false)

/** pretty-print；JSON 损坏无法解析时原样展示，与「原文排查」场景兼容 */
function prettyOrRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const jsonText = computed(() => {
  if (!props.item) return ''
  if (tab.value === 'workflow') {
    const raw = props.item.raw.workflow
    if (!raw) return t('detail.noWorkflow')
    return prettyJson.value ? prettyOrRaw(raw) : raw
  }
  const raw = props.item.raw.prompt ?? ''
  return raw && prettyJson.value ? prettyOrRaw(raw) : raw
})

async function copy(value: string | undefined, label: string) {
  if (!value) return
  const ok = await copyText(value)
  if (ok) message.success(t('detail.copied', { label }))
  else message.error(t('common.copyFailed'))
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
        <img
          v-if="item.url"
          :src="item.url"
          :alt="item.name"
          :title="t('detail.zoomIn')"
          @click="zoomed = true"
        />
        <div v-else class="detail-noimg">
          <Icon :name="item.metaOnly ? 'file-text' : 'image'" :size="26" :stroke="1.6" />
          <span>{{ item.metaOnly ? t('detail.metaFileNoPreview') : t('detail.imageNotLoaded') }}</span>
          <span v-if="!item.metaOnly" class="tip">{{ t('detail.reattachHint') }}</span>
        </div>
      </div>
      <div
        v-if="zoomed"
        class="img-zoom"
        role="button"
        :aria-label="t('detail.zoomClose')"
        @click="zoomed = false"
      >
        <img :src="item.url" :alt="item.name" />
      </div>

      <div class="detail-panel">
        <div class="fileline">
          <span style="flex: 1" :title="item.path ?? item.name">{{ item.path ?? item.name }}</span>
          <span :title="new Date(item.mtime).toLocaleString()">{{ fileTime }}</span>
          <span>{{ humanBytes(item.size) }}</span>
          <NButton size="tiny" quaternary circle :aria-label="t('detail.close')" @click="show = false">
            <template #icon><Icon name="x" :size="13" /></template>
          </NButton>
        </div>

        <template v-if="p">
          <div class="section">
            <div class="section-title">{{ t('detail.genParams') }}</div>
            <dl class="kv">
              <template v-for="([k, v], i) in generalRows" :key="i">
                <dt>{{ k }}</dt>
                <dd>
                  <span class="kv-val">{{ v }}</span>
                  <button class="kv-copy" type="button" :title="t('detail.copyField', { name: k })" @click="copy(v, k)">
                    <Icon name="copy" :size="11" :stroke="2.2" />
                  </button>
                </dd>
              </template>
            </dl>
          </div>

          <div v-if="samplerRows.length" class="section">
            <div class="section-title">
              <span
                >{{ t('detail.samplerParams')
                }}<template v-if="p.samplers.length > 1"
                  >{{ t('detail.stages', { n: p.samplers.length }) }}</template
                ></span
              >
            </div>
            <dl v-if="p.samplers.length === 1" class="kv">
              <template v-for="([k, v], i) in samplerRows" :key="i">
                <dt>{{ k }}</dt>
                <dd>
                  <span class="kv-val">{{ v }}</span>
                  <button class="kv-copy" type="button" :title="t('detail.copyField', { name: k })" @click="copy(v, k)">
                    <Icon name="copy" :size="11" :stroke="2.2" />
                  </button>
                </dd>
              </template>
            </dl>
            <div v-else>
              <div v-for="s in p.samplers" :key="s.nodeId" class="stage-row">
                <span class="txt">{{ stageText(s) }}</span>
              </div>
            </div>
          </div>

          <div v-if="p.loras.length" class="section">
            <div class="section-title">{{ t('detail.loraCount', { n: p.loras.length }) }}</div>
            <div v-for="l in p.loras" :key="l.name" class="stage-row">
              <span class="tag">{{ t('detail.loraTag') }}</span>
              <span class="txt">
                {{ l.name }}{{
                  t('detail.loraStrength', {
                    m: l.strengthModel ?? '-',
                    c: l.strengthClip ?? '-',
                    hash: l.hash ? ` · ${l.hash}` : '',
                  })
                }}
              </span>
              <button
                class="kv-copy"
                type="button"
                :title="t('detail.copyLoraName')"
                @click="copy(l.name, t('detail.loraTag'))"
              >
                <Icon name="copy" :size="11" :stroke="2.2" />
              </button>
            </div>
          </div>

          <div v-if="positiveText" class="section">
            <div class="section-title">
              <span>{{ t('detail.positive') }}</span>
              <NButton size="tiny" quaternary @click="copy(positiveText, t('detail.positive'))">
                <template #icon><Icon name="copy" :size="13" /></template>
                {{ t('common.copy') }}
              </NButton>
            </div>
            <pre class="prompt-text">{{ positiveText }}</pre>
          </div>

          <div v-if="negativeText" class="section">
            <div class="section-title">
              <span>{{ t('detail.negative') }}</span>
              <NButton size="tiny" quaternary @click="copy(negativeText, t('detail.negative'))">
                <template #icon><Icon name="copy" :size="13" /></template>
                {{ t('common.copy') }}
              </NButton>
            </div>
            <pre class="prompt-text">{{ negativeText }}</pre>
          </div>
        </template>

        <div v-else-if="item.status === 'error'" class="notice">
          <span class="notice-title">{{ t('detail.parseFailed') }}</span>
          <p class="err-message">{{ item.error ?? t('detail.unknownParseError') }}</p>
          <NButton v-if="item.file" size="small" secondary @click="retryItem(item)">
            <template #icon><Icon name="refresh" :size="13" /></template>
            {{ t('common.retry') }}
          </NButton>
        </div>
        <div v-else-if="item.status !== 'done'" class="notice">
          {{ t('detail.parsingNow') }}
          <br />
          <span style="font-size: 12px; color: var(--text-faint)">{{ t('detail.parsingHint') }}</span>
        </div>
        <div v-else-if="corruptRawText" class="notice">
          <span class="notice-title">{{ t('detail.corruptTitle') }}</span>
          <p class="err-message">{{ corruptHint }}</p>
        </div>
        <div v-else class="notice">
          {{ t('detail.noMetadata') }}
          <ul v-if="item.raw.hints?.length" class="hints">
            <li v-for="h in item.raw.hints" :key="h">{{ h }}</li>
          </ul>
        </div>

        <div v-if="showJsonTabs" class="section">
          <NTabs v-model:value="tab" type="segment" size="small" animated>
            <NTabPane v-if="item.raw.parameters" name="raw" :tab="t('detail.tabRaw')">
              <pre class="json-pre">{{ item.raw.parameters }}</pre>
              <div style="display: flex; gap: 8px; margin-top: 10px">
                <NButton size="tiny" secondary @click="copy(item.raw.parameters, t('detail.tabRaw'))">
                  <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                </NButton>
              </div>
            </NTabPane>
            <NTabPane v-if="item.raw.prompt" name="prompt" :tab="t('detail.tabPrompt')">
              <pre class="json-pre">{{ jsonText }}</pre>
              <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center">
                <NButton size="tiny" secondary @click="copy(item.raw.prompt, t('detail.tabPrompt'))">
                  <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                </NButton>
                <NButton size="tiny" secondary @click="downloadJson(item.raw.prompt, 'prompt.json')">
                  <template #icon><Icon name="download" :size="13" /></template>{{ t('common.download') }}
                </NButton>
                <label class="pretty-toggle">
                  <NSwitch v-model:value="prettyJson" size="small" />
                  {{ t('detail.prettyJson') }}
                </label>
              </div>
            </NTabPane>
            <NTabPane v-if="item.raw.source !== 'a1111'" name="workflow" :tab="t('detail.tabWorkflow')">
              <pre class="json-pre">{{ jsonText }}</pre>
              <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center">
                <NButton size="tiny" secondary @click="copy(item.raw.workflow, t('detail.tabWorkflow'))">
                  <template #icon><Icon name="copy" :size="13" /></template>{{ t('common.copy') }}
                </NButton>
                <NButton
                  size="tiny"
                  secondary
                  :disabled="!item.raw.workflow"
                  @click="downloadJson(item.raw.workflow, 'workflow.json')"
                >
                  <template #icon><Icon name="download" :size="13" /></template>{{ t('common.download') }}
                </NButton>
                <label class="pretty-toggle">
                  <NSwitch v-model:value="prettyJson" size="small" />
                  {{ t('detail.prettyJson') }}
                </label>
              </div>
              <p style="margin: 8px 0 0; font-size: 11.5px; color: var(--text-faint)">
                {{ t('detail.workflowHint') }}
              </p>
            </NTabPane>
          </NTabs>
        </div>

        <p class="kbd-hint">{{ t('detail.kbdHint') }}</p>
      </div>
    </div>
  </NDrawer>
</template>
