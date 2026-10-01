/**
 * E2E 冒烟测试：针对 vite-plugin-singlefile 产出的单文件 dist/index.html，
 * 在真实 Chromium 中走一遍核心链路：添加图片 → 解析 → 详情 → 统计 → 搜索 → 导出 → 持久化。
 *
 * 夹具不依赖仓库内文件：测试内自行构造带 ComfyUI tEXt 元数据的最小 PNG
 * （签名 + IHDR + tEXt(prompt) + IDAT + IEND，zlib 用 node:zlib，CRC32 自实现），
 * 与单元测试同一套 prompt JSON 结构，保证解析器行为一致。
 */
import { deflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'

/* ---------- PNG 夹具构造 ---------- */

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 与单元测试同构的 ComfyUI API 格式工作流（纯 ASCII，tEXt 为 Latin-1 安全） */
const COMFY_PROMPT = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 28,
      cfg: 6.5,
      sampler_name: 'euler_ancestral',
      scheduler: 'karras',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cozy cabin in snowy forest', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
}

function comfyPng(): Buffer {
  const w = 8
  const h = 8
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  const raw = Buffer.alloc(h * (1 + w * 3)) // 每行 1 字节 filter(0) + RGB 像素
  const text = Buffer.from(`prompt\0${JSON.stringify(COMFY_PROMPT)}`, 'latin1')
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG_PAYLOAD = { name: 'comfy-cabin.png', mimeType: 'image/png', buffer: comfyPng() }

/* ---------- 冒烟链路 ---------- */

test('解析 → 详情 → 统计 → 搜索 → 导出 CSV 全链路', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.brand-name')).toHaveText('ComfyUI·Info')
  await expect(page.getByText('把图片拖进来')).toBeVisible()

  // 添加图片（走 TopBar 隐藏的文件选择 input；目录 input 是第二个，必须 first()）
  await page.locator('input[type="file"]').first().setInputFiles(PNG_PAYLOAD)

  // 默认来源筛选 = ComfyUI 原图：卡片在解析完成（source 判定为 comfyui）后才出现
  const cards = page.locator('.card')
  await expect(cards).toHaveCount(1, { timeout: 15_000 })
  await expect(cards.first().locator('.src')).toHaveText('ComfyUI')

  // 打开详情抽屉：模型 / 提示词各区块可见
  await cards.first().click()
  const detail = page.locator('.detail')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('dreamshaper_8.safetensors')
  await expect(detail).toContainText('正向提示词')
  await expect(detail).toContainText('a cozy cabin in snowy forest')
  await page.getByRole('button', { name: '关闭详情' }).click()
  await expect(detail).not.toBeVisible()

  // 生成统计：模型聚合 1 条，点击条目应用筛选并关闭抽屉
  await page.getByRole('button', { name: '生成统计' }).click()
  const stats = page.locator('.stats')
  await expect(stats).toBeVisible()
  await expect(stats).toContainText('模型（1）')
  await stats.locator('.stat-row').first().click()
  await expect(stats).not.toBeVisible()
  await expect(cards).toHaveCount(1) // 模型筛选命中同一张

  // 搜索：命中提示词 → 1 张；无命中 → 空态；清空恢复
  const search = page.getByPlaceholder('搜索提示词 / 模型 / 种子（悬停看语法）')
  await search.fill('cozy')
  await expect(cards).toHaveCount(1)
  await search.fill('zzz-no-match')
  await expect(page.getByText('没有符合当前筛选的图片')).toBeVisible()
  await search.fill('')
  await expect(cards).toHaveCount(1)

  // 导出 CSV（Excel）：文件名带日期戳
  await page.getByRole('button', { name: '导出' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('导出 CSV (Excel)').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^comfyui-info-\d{4}-\d{2}-\d{2}\.csv$/)
})

test('刷新后解析结果从 IndexedDB 以存档卡片恢复', async ({ page }) => {
  // 持久化降级路径会打 console.warn / pageerror：全部捕获，失败时随断言输出便于定位
  const issues: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      issues.push(`${msg.type()}: ${msg.text()}`)
      console.log(`BROWSER-${msg.type().toUpperCase()}:`, msg.text())
    }
  })
  page.on('pageerror', (err) => issues.push(`pageerror: ${err.message}`))

  await page.goto('/')
  await page.waitForTimeout(1200) // 等 hydrate 完成，避免与首个 markDirty 竞态
  await page.locator('input[type="file"]').first().setInputFiles(PNG_PAYLOAD)
  await expect(page.locator('.card')).toHaveCount(1, { timeout: 15_000 })

  // 持久化有 500ms 防抖：等防抖窗口过去、记录确实写入 IndexedDB 后再刷新
  await page.waitForTimeout(1500)

  // 诊断断言：刷新前记录必须已在 IndexedDB 中（把失败切分为写入侧 / 恢复侧）
  const idbState = await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name)
    if (!names.includes('comfyui-info')) return { names, count: -1 }
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('comfyui-info')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction('items', 'readonly')
    const all = tx.objectStore('items').getAll()
    const rows = await new Promise<unknown[]>((res) => {
      all.onsuccess = () => res(all.result as unknown[])
      all.onerror = () => res([])
    })
    db.close()
    return { names, count: rows.length }
  })
  expect(idbState.count, `刷新前 IndexedDB 应已有存档记录: ${JSON.stringify(idbState)}`).toBeGreaterThan(0)

  await page.reload()
  // 存档项无文件本体：以「已存档」卡片呈现，参数仍可查看
  await expect(page.getByText('已存档')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.card')).toHaveCount(1)
  expect(issues, `页面不应有告警/异常，实际: ${issues.join(' | ')}`).toEqual([])
})
