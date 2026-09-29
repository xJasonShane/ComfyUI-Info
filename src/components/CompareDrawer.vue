<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NDrawer } from 'naive-ui'
import type { ImageItem, LoraInfo, ParsedParams } from '../types'

const props = defineProps<{ a: ImageItem | null; b: ImageItem | null }>()
const show = defineModel<boolean>('show', { default: false })

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

const narrowQuery = window.matchMedia('(max-width: 959.98px)')
const isNarrow = ref(narrowQuery.matches)
const onNarrowChange = (e: MediaQueryListEvent) => {
  isNarrow.value = e.matches
}
onMounted(() => narrowQuery.addEventListener('change', onNarrowChange))
onBeforeUnmount(() => narrowQuery.removeEventListener('change', onNarrowChange))
const drawerWidth = computed(() => (isNarrow.value ? '100%' : 940))

function textList(list: string[] | undefined): string | null {
  const s = (list ?? []).join('\n').trim()
  return s || null
}

function loraText(l: LoraInfo): string {
  return `${l.name}（m:${l.strengthModel ?? '-'} c:${l.strengthClip ?? '-'}${l.hash ? ` · ${l.hash}` : ''}）`
}

function sizeText(p: ParsedParams | undefined): string | null {
  if (!p?.width || !p?.height) return null
  const batch = p.batch && p.batch > 1 ? `，每批 ${p.batch} 张` : ''
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
      title: '基础',
      rows: [
        mk('文件', a.path ?? a.name, b.path ?? b.name),
        mk('模型', pa?.models.length ? pa.models.join(' + ') : null, pb?.models.length ? pb.models.join(' + ') : null),
        mk('出图尺寸', sizeText(pa), sizeText(pb)),
        mk(
          '工作流节点',
          pa?.nodeCount ? `${pa.nodeCount} 个` : null,
          pb?.nodeCount ? `${pb.nodeCount} 个` : null,
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
      const prefix = count > 1 ? `阶段${i + 1} · ` : ''
      rows.push(
        mk(`${prefix}采样器`, sa?.sampler ?? null, sb?.sampler ?? null),
        mk(`${prefix}调度器`, sa?.scheduler ?? null, sb?.scheduler ?? null),
        mk(`${prefix}步数`, sa?.steps != null ? String(sa.steps) : null, sb?.steps != null ? String(sb.steps) : null),
        mk(`${prefix}CFG`, sa?.cfg != null ? String(sa.cfg) : null, sb?.cfg != null ? String(sb.cfg) : null),
        mk(`${prefix}种子`, sa?.seed ?? null, sb?.seed ?? null),
        mk(`${prefix}重绘幅度`, sa?.denoise != null ? String(sa.denoise) : null, sb?.denoise != null ? String(sb.denoise) : null),
      )
    }
    sections.push({ title: '采样参数', rows })
  }

  const loras = loraRows(pa, pb)
  if (loras.length) sections.push({ title: 'LoRA', rows: loras })

  sections.push({
    title: '提示词',
    rows: [
      mk('正向提示词', textList(pa?.positive), textList(pb?.positive), true),
      mk('负向提示词', textList(pa?.negative), textList(pb?.negative), true),
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
        <span class="name" :title="nameA">{{ nameA }}</span>
        <span class="name" :title="nameB">{{ nameB }}</span>
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
      <p v-else class="cmp-none">所选图片还没有可对比的解析结果</p>
    </div>
  </NDrawer>
</template>
