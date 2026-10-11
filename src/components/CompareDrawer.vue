<script setup lang="ts">
import { computed, watch } from 'vue'
import { NDrawer } from 'naive-ui'
import type { ImageItem, LoraInfo, ParsedParams } from '../types'
import { ensureItemUrl } from '../composables/store'
import { useDrawerWidth } from '../composables/ui'
import { t } from '../locales'

const props = defineProps<{ a: ImageItem | null; b: ImageItem | null }>()
const show = defineModel<boolean>('show', { default: false })

// FEAT-8：对比双方按需创建预览 URL，头部并排展示缩略图
watch(
  () => [props.a?.id, props.b?.id],
  () => {
    if (props.a) ensureItemUrl(props.a)
    if (props.b) ensureItemUrl(props.b)
  },
  { immediate: true },
)

interface DiffRow {
  label: string
  a: string | null
  b: string | null
  /** 长文本（提示词）用 pre 展示 */
  long?: boolean
}

interface DiffSection {
  title: string
  rows: DiffRow[]
}

const drawerWidth = useDrawerWidth(940)

function textList(list: string[] | undefined): string | null {
  const s = (list ?? []).join('\n').trim()
  return s || null
}

function loraText(l: LoraInfo): string {
  return `${l.name}（m:${l.strengthModel ?? '-'} c:${l.strengthClip ?? '-'}${l.hash ? ` · ${l.hash}` : ''}）`
}

function sizeText(p: ParsedParams | undefined): string | null {
  if (!p?.width || !p?.height) return null
  const batch = p.batch && p.batch > 1 ? t('detail.perBatch', { n: p.batch }) : ''
  return `${p.width} × ${p.height}${batch}`
}

function loraRows(pa?: ParsedParams, pb?: ParsedParams): DiffRow[] {
  const names: string[] = []
  for (const l of [...(pa?.loras ?? []), ...(pb?.loras ?? [])]) {
    if (!names.includes(l.name)) names.push(l.name)
  }
  const find = (p: ParsedParams | undefined, name: string) =>
    p?.loras.find((l) => l.name === name)
  return names.map((name) => {
    const la = find(pa, name)
    const lb = find(pb, name)
    return {
      label: name,
      a: la ? loraText(la) : null,
      b: lb ? loraText(lb) : null,
    }
  })
}

const sections = computed<DiffSection[]>(() => {
  const a = props.a
  const b = props.b
  if (!a || !b) return []
  const pa = a.params
  const pb = b.params
  const mk = (label: string, va: string | null, vb: string | null, long = false): DiffRow => ({
    label,
    a: va,
    b: vb,
    long,
  })

  const sections: DiffSection[] = [
    {
      title: t('cmp.basics'),
      rows: [
        mk(t('cmp.file'), a.path ?? a.name, b.path ?? b.name),
        mk(t('detail.model'), pa?.models.length ? pa.models.join(' + ') : null, pb?.models.length ? pb.models.join(' + ') : null),
        mk(t('detail.vae'), pa?.vaes.length ? pa.vaes.join(' + ') : null, pb?.vaes.length ? pb.vaes.join(' + ') : null),
        mk(t('detail.clipSkip'), pa?.clipSkip != null ? String(pa.clipSkip) : null, pb?.clipSkip != null ? String(pb.clipSkip) : null),
        mk(t('detail.size'), sizeText(pa), sizeText(pb)),
        mk(
          t('detail.upscaler'),
          pa?.upscalers.length ? pa.upscalers.join(' + ') : null,
          pb?.upscalers.length ? pb.upscalers.join(' + ') : null,
        ),
        mk(
          t('detail.controlnet'),
          pa?.controlNets.length ? pa.controlNets.join(' + ') : null,
          pb?.controlNets.length ? pb.controlNets.join(' + ') : null,
        ),
        mk(
          t('detail.nodeCount'),
          pa?.nodeCount ? t('detail.nodes', { n: pa.nodeCount }) : null,
          pb?.nodeCount ? t('detail.nodes', { n: pb.nodeCount }) : null,
        ),
      ],
    },
  ]

  const count = Math.max(pa?.samplers.length ?? 0, pb?.samplers.length ?? 0)
  if (count) {
    const rows: DiffRow[] = []
    for (let i = 0; i < count; i++) {
      const sa = pa?.samplers[i]
      const sb = pb?.samplers[i]
      const prefix = count > 1 ? t('cmp.stage', { n: i + 1 }) : ''
      rows.push(
        mk(`${prefix}${t('detail.sampler')}`, sa?.sampler ?? null, sb?.sampler ?? null),
        mk(`${prefix}${t('detail.scheduler')}`, sa?.scheduler ?? null, sb?.scheduler ?? null),
        mk(`${prefix}${t('detail.steps')}`, sa?.steps != null ? String(sa.steps) : null, sb?.steps != null ? String(sb.steps) : null),
        mk(`${prefix}${t('detail.cfg')}`, sa?.cfg != null ? String(sa.cfg) : null, sb?.cfg != null ? String(sb.cfg) : null),
        mk(`${prefix}${t('detail.seed')}`, sa?.seed ?? null, sb?.seed ?? null),
        mk(`${prefix}${t('detail.denoise')}`, sa?.denoise != null ? String(sa.denoise) : null, sb?.denoise != null ? String(sb.denoise) : null),
      )
    }
    sections.push({ title: t('cmp.samplerParams'), rows })
  }

  const loras = loraRows(pa, pb)
  if (loras.length) sections.push({ title: t('cmp.loras'), rows: loras })

  sections.push({
    title: t('cmp.prompts'),
    rows: [
      mk(t('detail.positive'), textList(pa?.positive), textList(pb?.positive), true),
      mk(t('detail.negative'), textList(pa?.negative), textList(pb?.negative), true),
    ],
  })
  return sections
})

const nameA = computed(() => props.a?.path ?? props.a?.name ?? '')
const nameB = computed(() => props.b?.path ?? props.b?.name ?? '')
</script>

<template>
  <NDrawer v-model:show="show" :width="drawerWidth" placement="right">
    <div class="cmp">
      <div class="cmp-head">
        <span class="cmp-empty" />
        <div class="cmp-item">
          <img v-if="a?.url" :src="a.url" alt="" />
          <span class="name" :title="nameA">{{ nameA }}</span>
        </div>
        <div class="cmp-item">
          <img v-if="b?.url" :src="b.url" alt="" />
          <span class="name" :title="nameB">{{ nameB }}</span>
        </div>
      </div>

      <template v-if="sections.length">
        <section v-for="sec in sections" :key="sec.title" class="cmp-section">
          <div class="cmp-section-title">{{ sec.title }}</div>
          <div
            v-for="(row, i) in sec.rows"
            :key="i"
            class="cmp-row"
            :class="{ diff: row.a !== row.b }"
          >
            <span class="label">{{ row.label }}</span>
            <pre v-if="row.long" class="val" :class="{ empty: !row.a }">{{ row.a ?? '—' }}</pre>
            <span v-else class="val" :class="{ empty: !row.a }">{{ row.a ?? '—' }}</span>
            <pre v-if="row.long" class="val" :class="{ empty: !row.b }">{{ row.b ?? '—' }}</pre>
            <span v-else class="val" :class="{ empty: !row.b }">{{ row.b ?? '—' }}</span>
          </div>
        </section>
      </template>
      <p v-else class="cmp-none">{{ t('cmp.none') }}</p>
    </div>
  </NDrawer>
</template>
