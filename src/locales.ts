/**
 * 最小 i18n（FEAT-9）：轻量词典 + t()，不引重型 i18n 框架。
 * - zh 为基准词典，en 与键一一对应（Record<DictKey, string> 缺键即编译错误）
 * - 默认跟随浏览器语言（无信号时回退中文）；切换偏好持久化
 * - t() 读取响应式 locale，在模板 / computed 中调用即随切换重渲染；
 *   事件回调中的即时文案（如消息提示）在调用瞬间取值，无需追踪
 * - 已知边界：解析器产出的诊断线索（metadata.ts hints，属存档数据）与解析错误信息保持原文
 */
import { ref } from 'vue'

export type Locale = 'zh' | 'en'

const zh = {
  /* 通用 */
  'common.copy': '复制',
  'common.download': '下载',
  'common.retry': '重试',
  'common.copyFailed': '复制失败，请手动选择文本复制',
  'common.exportWhileParsing': '扫描仍在进行，请等扫描完成后再导出',
  'common.exportedItems': '已导出 {n} 项',
  'common.unknownError': '未知错误',

  /* 导出下拉选项 */
  'export.json': '导出 JSON',
  'export.csv': '导出 CSV (Excel)',
  'export.zip': '导出工作流 (ZIP)',

  /* 来源与排序 */
  'src.comfyui': 'ComfyUI 原图',
  'src.a1111': 'A1111 / WebUI',
  'src.none': '无元数据',
  'src.error': '解析失败',
  'src.all': '全部图片',
  'sort.default': '默认排序',
  'sort.timeDesc': '时间 新→旧',
  'sort.timeAsc': '时间 旧→新',
  'sort.workflow': '按工作流聚类',

  /* 状态行（App） */
  'stat.loaded': '已加载',
  'stat.parsing': '扫描中…',
  'stat.filtered': '筛选命中 {n} 张',
  'stat.errorTitle': '点击查看解析失败的图片',
  'stat.retryAllTitle': '重试全部解析失败的图片',
  'msg.retried': '已重新排队 {n} 张失败图片',
  'msg.nothingToRetry': '没有可重试的失败项（存档失败项需重新拖入原文件）',

  /* 批量操作条 */
  'bar.selected': '已选 <b>{n}</b> 张',
  'bar.selectAllFiltered': '全选筛选结果',
  'bar.compare': '对比',
  'bar.compareTitle': '两张图需都已解析出参数',
  'bar.copyPrompts': '复制提示词',
  'bar.exportSelected': '导出选中',
  'bar.removeSelected': '移除选中',
  'bar.removeConfirm': '确定移除选中的 {n} 张图片？',
  'bar.clearSelection': '取消选择',
  'msg.copiedPrompts': '已复制 {n} 张图片的正向提示词',
  'msg.noParsedPrompts': '所选图片中还没有已解析出提示词的项',
  'msg.noExportable': '所选图片中还没有可导出的结果',
  'msg.pasted': '已粘贴添加 {n} 项',

  /* 拖拽覆盖层 */
  'drop.hint': '松开以添加图片 / 文件夹 / 工作流文件',
  'app.backTop': '回到顶部',

  /* TopBar */
  'topbar.subtitle': '图片信息查看器',
  'topbar.addImages': '添加图片',
  'topbar.addFolder': '添加文件夹',
  'topbar.pickDirTitleFsa': '选择目录（将记住该目录，可一键重扫增量更新）',
  'topbar.pickDirTitlePlain': '选择目录（递归扫描子文件夹）',
  'topbar.rescan': '重扫',
  'topbar.rescanTooltip': '重新扫描记住的目录「{name}」，只添加新文件，已有图片按指纹回挂去重',
  'topbar.autoRescanAria': '自动重扫开关',
  'topbar.autoRescanTooltip': '自动重扫：每 10 秒增量扫描「{name}」，只添加新文件（边出图边看）',
  'topbar.dirs': '目录',
  'topbar.dirsTitle': '已记住的目录（点击切换重扫目标）',
  'topbar.clearBookmarks': '清除全部书签',
  'msg.bookmarksCleared': '已清除全部目录书签',
  'msg.forgetDir': '已不再记住该目录',
  'topbar.forgetTitle': '不再记住该目录',
  'topbar.forgetConfirm': '确定不再记住目录「{name}」？',
  'msg.rescanNoPermission': '未能获得目录读取权限，无法重扫',
  'msg.rescanStarted': '正在重新扫描「{name}」…',
  'msg.rescanNoNew': '「{name}」没有新增图片，列表保持不变',
  'msg.dirEmpty': '目录「{name}」中没有找到图片文件',
  'topbar.export': '导出',
  'topbar.archive': '存档',
  'topbar.archiveTitle': '备份 / 恢复本地存档（参数与诊断信息，不含图片本体）',
  'archive.export': '导出存档备份',
  'archive.import': '导入存档备份',
  'msg.archiveEmpty': '当前列表没有可备份的存档记录',
  'msg.archiveExported': '已导出 {n} 条存档记录（不含图片本体）',
  'msg.archiveImported': '已导入 {n} 条存档记录',
  'msg.archiveAllExists': '备份中的记录均已存在，未新增',
  'msg.archiveImportFailed': '导入失败：{msg}',
  'topbar.searchPlaceholder': '搜索提示词 / 模型 / 种子（悬停看语法）',
  'help.title': '搜索语法',
  'help.model': '<code>model:xxx</code> 按模型名筛选',
  'help.lora': '<code>lora:xxx</code> 按 LoRA 名称或哈希',
  'help.seed': '<code>seed:123</code> 按种子（支持片段）',
  'help.seedRange': '<code>seed:&gt;100</code> 种子范围（&gt; ≥ &lt; ≤）',
  'help.numRange':
    '<code>steps:&gt;30</code> / <code>cfg:&lt;8</code> / <code>w:&gt;=1024</code> 数值范围',
  'help.date': '<code>date:2026-01-31</code> 按日期（本地时区，支持年 / 月前缀）',
  'help.path': '<code>path:目录</code> 按相对路径',
  'help.exclude': '<code>-关键词</code> 排除（如 <code>-blurry</code>、<code>-model:xx</code>）',
  'help.quoted':
    '<code>"model:a b"</code> 或 <code>model:"a b"</code> 引号包裹可含空格，可与 <code>-</code> 连用',
  'help.and': '多个正向条件空格分隔，全部满足才命中',
  'topbar.modelPlaceholder': '按模型筛选',
  'topbar.dupeOnlyAria': '只看重复',
  'topbar.dupeOnlyTooltip': '只看重复：仅显示同工作流同种子的同源出图',
  'topbar.favOnlyAria': '只看收藏',
  'topbar.favOnlyTooltip': '只看收藏：仅显示已星标的 {n} 张图片',
  'topbar.stats': '生成统计',
  'topbar.statsTooltip': '按模型 / LoRA / 采样器聚合使用频次',
  'topbar.thumbSize': '缩略图大小',
  'topbar.themeToLight': '切换浅色主题',
  'topbar.themeToDark': '切换深色主题',
  'topbar.clearAll': '清空列表',
  'topbar.clearAllConfirm': '确定清空当前已加载的全部图片？已持久化的历史记录会一并清除。',
  'topbar.localeAria': '切换语言 / Switch language',

  /* ImageCard */
  'card.openAria': '{name}，查看详情',
  'card.errorTitle': '{path}（{error}）',
  'card.parsing': '解析中',
  'card.select': '选中',
  'card.unselect': '取消选中',
  'card.selectAria': '选中这张图片',
  'card.fav': '收藏',
  'card.unfav': '取消收藏',
  'card.favAria': '切换收藏',
  'card.removeTitle': '从列表移除',
  'card.removeAria': '从列表移除这张图片',
  'card.metaFile': '参数文件',
  'card.metaFileTip': '无预览图',
  'card.archived': '已存档',
  'card.archivedTip': '重新拖入原文件可回挂',
  'card.broken': '无法预览',
  'card.sameSource': '同源 {x}/{y}',
  'card.sameSourceTitle': '同工作流同种子的同源出图',
  'card.sameWorkflow': '同款 {x}/{y}',
  'card.sameWorkflowTitle': '同工作流出图序号',

  /* DetailDrawer */
  'detail.close': '关闭详情',
  'detail.prev': '上一张',
  'detail.next': '下一张',
  'detail.copyField': '复制{name}',
  'detail.zoomIn': '点击放大',
  'detail.zoomClose': '关闭放大',
  'detail.copyImage': '复制图片到剪贴板（转 PNG）',
  'detail.downloadImage': '下载原图',
  'detail.imageCopied': '图片已复制到剪贴板',
  'detail.imageCopyFailed': '复制图片失败：浏览器不支持或未授权剪贴板访问',
  'detail.upscaled': '已放大 ×{r}',
  'detail.downscaled': '已缩小 ×{r}',
  'detail.dimsMismatch': '与参数尺寸不一致',
  'detail.dimsDiffTitle':
    '实际分辨率 {w} × {h}，参数出图尺寸 {pw} × {ph}（不一致通常来自高清修复 / 后处理）',
  'detail.metaFileNoPreview': '参数文件（无预览图）',
  'detail.imageNotLoaded': '图片未加载',
  'detail.reattachHint': '重新拖入原文件即可回挂预览',
  'detail.genParams': '生成参数',
  'detail.copySummary': '复制参数摘要',
  'detail.model': '模型',
  'detail.vae': 'VAE',
  'detail.clipSkip': 'Clip Skip',
  'detail.size': '出图尺寸',
  'detail.perBatch': '，每批 {n} 张',
  'detail.upscaler': '放大模型',
  'detail.controlnet': 'ControlNet',
  'detail.nodeCount': '工作流节点',
  'detail.nodes': '{n} 个',
  'detail.samplerParams': '采样参数',
  'detail.stages': '（{n} 阶段）',
  'detail.sampler': '采样器',
  'detail.scheduler': '调度器',
  'detail.steps': '步数',
  'detail.cfg': 'CFG',
  'detail.seed': '种子',
  'detail.denoise': '重绘幅度',
  'detail.loraCount': 'LoRA（{n}）',
  'detail.loraTag': 'LoRA',
  'detail.loraStrength': '（模型强度 {m} / 文本强度 {c}{hash}）',
  'detail.copyLoraName': '复制 LoRA 名称',
  'detail.positive': '正向提示词',
  'detail.negative': '负向提示词',
  'detail.parseFailed': '解析失败',
  'detail.unknownParseError': '读取图片元数据时发生未知错误',
  'detail.parsingNow': '正在解析元数据…',
  'detail.parsingHint': '稍等片刻，参数马上出来',
  'detail.corruptTitle': '检测到生成元数据，但无法提取结构化参数',
  'detail.corruptUiOnly':
    '检测到 UI 工作流，但无法从中提取结构化参数；可在下方「UI 工作流」页签查看或下载',
  'detail.corruptJson':
    '内嵌的工作流 JSON 无法解析（可能被截断或损坏），可在下方查看原始 JSON 排查',
  'detail.corruptText': '参数文本无法解析为结构化参数，可在下方查看原文',
  'detail.noMetadata': '未检测到 ComfyUI / A1111 生成元数据',
  'detail.tabRaw': '原始参数',
  'detail.tabPrompt': 'Prompt JSON',
  'detail.tabWorkflow': 'UI 工作流',
  'detail.noWorkflow': '（此图未内嵌 UI 工作流）',
  'detail.prettyJson': '格式化显示',
  'detail.workflowHint': '下载的 workflow.json 可直接拖入 ComfyUI 画布恢复整个工作流。',
  'detail.kbdHint': '← / → 切换图片 · Esc 关闭',
  'detail.copied': '{label}已复制',

  /* CompareDrawer */
  'cmp.basics': '基础',
  'cmp.samplerParams': '采样参数',
  'cmp.loras': 'LoRA',
  'cmp.prompts': '提示词',
  'cmp.file': '文件',
  'cmp.stage': '阶段{n} · ',
  'cmp.none': '所选图片还没有可对比的解析结果',

  /* StatsDrawer */
  'stats.title': '生成统计',
  'stats.sub': '按已解析图片聚合使用频次，点击条目可直接筛选',
  'stats.close': '关闭统计',
  'stats.exportCsv': '导出 CSV',
  'stats.exportTitle': '导出全部统计频次为 CSV',
  'stats.models': '模型',
  'stats.loras': 'LoRA',
  'stats.samplers': '采样器',
  'stats.trend': '出图趋势',
  'stats.keywords': '高频提示词',
  'stats.emptySection': '暂无数据',
  'stats.empty': '还没有已解析出参数的图片——先添加一些图片，再来看统计。',
  'stats.filterHint': '筛选{title}「{name}」',

  /* EmptyState */
  'empty.filtered': '没有符合当前筛选的图片',
  'empty.hidden':
    '已解析的图片中有 <b>{n}</b> 张被来源 / 搜索 / 模型筛选隐藏。它们可能以 A1111 兼容格式保存（ComfyUI 生态常见，拖回 ComfyUI 同样能自动转换成工作流）。',
  'empty.adjust': '试试调整搜索关键词、模型或来源筛选，也可以直接拖入更多图片或文件夹。',
  'empty.showAll': '查看全部 {n} 张',
  'empty.dropTitle': '把图片拖进来',
  'empty.intro':
    '支持<b>单张、多张或整个文件夹</b>（也可拖拽目录），自动扫描其中的 ComfyUI 原图并读取内置元数据：提示词、模型、CFG、步数、种子、采样器等。所有解析都在本地浏览器完成，图片不会上传。',
  'empty.chipLocal': '100% 本地解析',
  'empty.chipFormats': 'PNG · JPEG · WebP',
  'empty.chipSources': 'ComfyUI · A1111',
  'empty.chipFiles': '工作流 JSON / TXT',
  'empty.chipCopy': '一键复制提示词',

  /* 导出 CSV 表头（含统计导出） */
  'csv.name': '文件名',
  'csv.path': '路径',
  'csv.size': '大小(字节)',
  'csv.source': '来源',
  'csv.mtime': '修改时间',
  'csv.models': '模型',
  'csv.modelHash': '模型哈希',
  'csv.loras': 'LoRA',
  'csv.clipSkip': 'Clip Skip',
  'csv.vae': 'VAE',
  'csv.upscalers': '放大模型',
  'csv.controlnets': 'ControlNet',
  'csv.sampler': '采样器',
  'csv.scheduler': '调度器',
  'csv.steps': '步数',
  'csv.cfg': 'CFG',
  'csv.seed': '种子',
  'csv.denoise': '重绘幅度',
  'csv.width': '宽',
  'csv.height': '高',
  'csv.batch': '批量',
  'csv.stages': '多阶段',
  'csv.positive': '正向提示词',
  'csv.negative': '负向提示词',
  'csv.error': '错误',
  'csv.category': '类别',
  'csv.count': '次数',
} as const

export type DictKey = keyof typeof zh

/** en 与 zh 键一一对应：缺键 / 多键都是编译错误 */
const en: Record<DictKey, string> = {
  'common.copy': 'Copy',
  'common.download': 'Download',
  'common.retry': 'Retry',
  'common.copyFailed': 'Copy failed, please copy the text manually',
  'common.exportWhileParsing': 'Scan still in progress, please export after it finishes',
  'common.exportedItems': 'Exported {n} items',
  'common.unknownError': 'Unknown error',

  'export.json': 'Export JSON',
  'export.csv': 'Export CSV (Excel)',
  'export.zip': 'Export workflows (ZIP)',

  'src.comfyui': 'ComfyUI originals',
  'src.a1111': 'A1111 / WebUI',
  'src.none': 'No metadata',
  'src.error': 'Parse failed',
  'src.all': 'All images',
  'sort.default': 'Default',
  'sort.timeDesc': 'Time new→old',
  'sort.timeAsc': 'Time old→new',
  'sort.workflow': 'By workflow',

  'stat.loaded': 'Loaded',
  'stat.parsing': 'Scanning…',
  'stat.filtered': '{n} match filters',
  'stat.errorTitle': 'Click to view images that failed to parse',
  'stat.retryAllTitle': 'Retry all failed images',
  'msg.retried': 'Re-queued {n} failed images',
  'msg.nothingToRetry': 'Nothing to retry (archived failures need the original files re-added)',

  'bar.selected': 'Selected <b>{n}</b>',
  'bar.selectAllFiltered': 'Select all filtered',
  'bar.compare': 'Compare',
  'bar.compareTitle': 'Both images need parsed parameters',
  'bar.copyPrompts': 'Copy prompts',
  'bar.exportSelected': 'Export selected',
  'bar.removeSelected': 'Remove selected',
  'bar.removeConfirm': 'Remove the {n} selected images?',
  'bar.clearSelection': 'Clear selection',
  'msg.copiedPrompts': 'Copied positive prompts of {n} images',
  'msg.noParsedPrompts': 'No selected images have parsed prompts yet',
  'msg.noExportable': 'No exportable results in the selection',
  'msg.pasted': 'Added {n} items from clipboard',

  'drop.hint': 'Drop to add images / folders / workflow files',
  'app.backTop': 'Back to top',

  'topbar.subtitle': 'Image metadata viewer',
  'topbar.addImages': 'Add images',
  'topbar.addFolder': 'Add folder',
  'topbar.pickDirTitleFsa': 'Pick a directory (remembered for one-click incremental rescan)',
  'topbar.pickDirTitlePlain': 'Pick a directory (scans subfolders recursively)',
  'topbar.rescan': 'Rescan',
  'topbar.rescanTooltip':
    'Rescan remembered directory "{name}": only new files are added; existing ones are matched by fingerprint',
  'topbar.autoRescanAria': 'Auto rescan toggle',
  'topbar.autoRescanTooltip':
    'Auto rescan: incrementally scan "{name}" every 10s, adding only new files',
  'topbar.dirs': 'Dirs',
  'topbar.dirsTitle': 'Remembered directories (click to switch the rescan target)',
  'topbar.clearBookmarks': 'Clear all bookmarks',
  'msg.bookmarksCleared': 'All directory bookmarks cleared',
  'msg.forgetDir': 'Directory forgotten',
  'topbar.forgetTitle': 'Forget this directory',
  'topbar.forgetConfirm': 'Stop remembering directory "{name}"?',
  'msg.rescanNoPermission': 'Directory read permission was not granted; cannot rescan',
  'msg.rescanStarted': 'Rescanning "{name}"…',
  'msg.rescanNoNew': 'No new images in "{name}"; list unchanged',
  'msg.dirEmpty': 'No image files found in directory "{name}"',
  'topbar.export': 'Export',
  'topbar.archive': 'Archive',
  'topbar.archiveTitle':
    'Back up / restore the local archive (parameters & diagnostics, no images)',
  'archive.export': 'Export archive backup',
  'archive.import': 'Import archive backup',
  'msg.archiveEmpty': 'No archivable records in the current list',
  'msg.archiveExported': 'Exported {n} archive records (no image data)',
  'msg.archiveImported': 'Imported {n} archive records',
  'msg.archiveAllExists': 'All records in the backup already exist; nothing added',
  'msg.archiveImportFailed': 'Import failed: {msg}',
  'topbar.searchPlaceholder': 'Search prompts / model / seed (hover for syntax)',
  'help.title': 'Search syntax',
  'help.model': '<code>model:xxx</code> filter by model name',
  'help.lora': '<code>lora:xxx</code> by LoRA name or hash',
  'help.seed': '<code>seed:123</code> by seed (substring)',
  'help.seedRange': '<code>seed:&gt;100</code> seed range (&gt; ≥ &lt; ≤)',
  'help.numRange':
    '<code>steps:&gt;30</code> / <code>cfg:&lt;8</code> / <code>w:&gt;=1024</code> numeric range',
  'help.date': '<code>date:2026-01-31</code> by date (local timezone, year / month prefixes work)',
  'help.path': '<code>path:dir</code> by relative path',
  'help.exclude': '<code>-term</code> exclude (e.g. <code>-blurry</code>, <code>-model:xx</code>)',
  'help.quoted':
    '<code>"model:a b"</code> / <code>model:"a b"</code> quotes allow spaces, combinable with <code>-</code>',
  'help.and': 'Multiple positive terms are space-separated AND conditions',
  'topbar.modelPlaceholder': 'Filter by model',
  'topbar.dupeOnlyAria': 'Duplicates only',
  'topbar.dupeOnlyTooltip': 'Duplicates only: same workflow + same seed (same-origin images)',
  'topbar.favOnlyAria': 'Favorites only',
  'topbar.favOnlyTooltip': 'Favorites only: show the {n} starred images',
  'topbar.stats': 'Usage stats',
  'topbar.statsTooltip': 'Aggregate usage of models / LoRAs / samplers',
  'topbar.thumbSize': 'Thumbnail size',
  'topbar.themeToLight': 'Switch to light theme',
  'topbar.themeToDark': 'Switch to dark theme',
  'topbar.clearAll': 'Clear list',
  'topbar.clearAllConfirm':
    'Clear all loaded images? Persisted history records will be removed as well.',
  'topbar.localeAria': '切换语言 / Switch language',

  'card.openAria': '{name}, view details',
  'card.errorTitle': '{path} ({error})',
  'card.parsing': 'Parsing',
  'card.select': 'Select',
  'card.unselect': 'Deselect',
  'card.selectAria': 'Select this image',
  'card.fav': 'Favorite',
  'card.unfav': 'Unfavorite',
  'card.favAria': 'Toggle favorite',
  'card.removeTitle': 'Remove from list',
  'card.removeAria': 'Remove this image from the list',
  'card.metaFile': 'Params file',
  'card.metaFileTip': 'No preview',
  'card.archived': 'Archived',
  'card.archivedTip': 'Re-drop the original file to re-attach',
  'card.broken': 'No preview',
  'card.sameSource': 'Same {x}/{y}',
  'card.sameSourceTitle': 'Same workflow + same seed (same-origin images)',
  'card.sameWorkflow': 'Same {x}/{y}',
  'card.sameWorkflowTitle': 'Position within the same workflow',

  'detail.close': 'Close details',
  'detail.prev': 'Previous image',
  'detail.next': 'Next image',
  'detail.copyField': 'Copy {name}',
  'detail.zoomIn': 'Click to zoom',
  'detail.zoomClose': 'Close zoom',
  'detail.copyImage': 'Copy image to clipboard (as PNG)',
  'detail.downloadImage': 'Download image',
  'detail.imageCopied': 'Image copied to clipboard',
  'detail.imageCopyFailed': 'Failed to copy image: clipboard unavailable or permission denied',
  'detail.upscaled': 'Upscaled ×{r}',
  'detail.downscaled': 'Downscaled ×{r}',
  'detail.dimsMismatch': 'Differs from params',
  'detail.dimsDiffTitle':
    'Actual {w} × {h}, param size {pw} × {ph} (the difference usually comes from hires fix / post-processing)',
  'detail.metaFileNoPreview': 'Params file (no preview)',
  'detail.imageNotLoaded': 'Image not loaded',
  'detail.reattachHint': 'Re-drop the original file to re-attach the preview',
  'detail.genParams': 'Generation parameters',
  'detail.copySummary': 'Copy summary',
  'detail.model': 'Model',
  'detail.vae': 'VAE',
  'detail.clipSkip': 'Clip Skip',
  'detail.size': 'Output size',
  'detail.perBatch': ', {n} per batch',
  'detail.upscaler': 'Upscale model',
  'detail.controlnet': 'ControlNet',
  'detail.nodeCount': 'Workflow nodes',
  'detail.nodes': '{n} nodes',
  'detail.samplerParams': 'Sampler parameters',
  'detail.stages': ' ({n} stages)',
  'detail.sampler': 'Sampler',
  'detail.scheduler': 'Scheduler',
  'detail.steps': 'Steps',
  'detail.cfg': 'CFG',
  'detail.seed': 'Seed',
  'detail.denoise': 'Denoise',
  'detail.loraCount': 'LoRAs ({n})',
  'detail.loraTag': 'LoRA',
  'detail.loraStrength': ' (model {m} / text {c}{hash})',
  'detail.copyLoraName': 'Copy LoRA name',
  'detail.positive': 'Positive prompt',
  'detail.negative': 'Negative prompt',
  'detail.parseFailed': 'Parse failed',
  'detail.unknownParseError': 'Unknown error while reading image metadata',
  'detail.parsingNow': 'Parsing metadata…',
  'detail.parsingHint': 'One moment, parameters are on the way',
  'detail.corruptTitle': 'Metadata found, but structured parameters could not be extracted',
  'detail.corruptUiOnly':
    'A UI workflow was found but no structured parameters could be extracted; view or download it in the "UI workflow" tab below',
  'detail.corruptJson':
    'The embedded workflow JSON cannot be parsed (possibly truncated or corrupted); inspect the raw JSON below',
  'detail.corruptText':
    'The parameter text cannot be parsed into structured parameters; view the raw text below',
  'detail.noMetadata': 'No ComfyUI / A1111 generation metadata detected',
  'detail.tabRaw': 'Raw params',
  'detail.tabPrompt': 'Prompt JSON',
  'detail.tabWorkflow': 'UI workflow',
  'detail.noWorkflow': '(no embedded UI workflow)',
  'detail.prettyJson': 'Pretty-print',
  'detail.workflowHint':
    'The downloaded workflow.json can be dropped onto the ComfyUI canvas to restore the workflow.',
  'detail.kbdHint': '← / → switch images · Esc closes',
  'detail.copied': '{label} copied',

  'cmp.basics': 'Basics',
  'cmp.samplerParams': 'Sampler parameters',
  'cmp.loras': 'LoRAs',
  'cmp.prompts': 'Prompts',
  'cmp.file': 'File',
  'cmp.stage': 'Stage {n} · ',
  'cmp.none': 'No parsed results to compare yet',

  'stats.title': 'Usage stats',
  'stats.sub': 'Aggregated from parsed images; click a row to filter',
  'stats.close': 'Close stats',
  'stats.exportCsv': 'Export CSV',
  'stats.exportTitle': 'Export all frequency stats as CSV',
  'stats.models': 'Models',
  'stats.loras': 'LoRAs',
  'stats.samplers': 'Samplers',
  'stats.trend': 'Daily output',
  'stats.keywords': 'Top prompt keywords',
  'stats.emptySection': 'No data yet',
  'stats.empty': 'No parsed images yet — add some images first, then check the stats.',
  'stats.filterHint': 'Filter {title} "{name}"',

  'empty.filtered': 'No images match the current filters',
  'empty.hidden':
    '<b>{n}</b> parsed images are hidden by the source / search / model filters. They may be saved in the A1111-compatible format (common in the ComfyUI ecosystem; dragging them back to ComfyUI converts them into workflows as well).',
  'empty.adjust':
    'Try adjusting the search keywords, model or source filters, or drop in more images or folders.',
  'empty.showAll': 'Show all {n}',
  'empty.dropTitle': 'Drop images here',
  'empty.intro':
    'Supports <b>single images, batches or whole folders</b> (directories can be dropped too). ComfyUI originals are scanned automatically and their embedded metadata read: prompts, model, CFG, steps, seed, samplers and more. All parsing happens locally in your browser; images are never uploaded.',
  'empty.chipLocal': '100% local parsing',
  'empty.chipFormats': 'PNG · JPEG · WebP',
  'empty.chipSources': 'ComfyUI · A1111',
  'empty.chipFiles': 'Workflow JSON / TXT',
  'empty.chipCopy': 'One-click prompt copy',

  'csv.name': 'File',
  'csv.path': 'Path',
  'csv.size': 'Size (bytes)',
  'csv.source': 'Source',
  'csv.mtime': 'Modified',
  'csv.models': 'Models',
  'csv.modelHash': 'Model hash',
  'csv.loras': 'LoRAs',
  'csv.clipSkip': 'Clip Skip',
  'csv.vae': 'VAE',
  'csv.upscalers': 'Upscale models',
  'csv.controlnets': 'ControlNets',
  'csv.sampler': 'Sampler',
  'csv.scheduler': 'Scheduler',
  'csv.steps': 'Steps',
  'csv.cfg': 'CFG',
  'csv.seed': 'Seed',
  'csv.denoise': 'Denoise',
  'csv.width': 'Width',
  'csv.height': 'Height',
  'csv.batch': 'Batch',
  'csv.stages': 'Extra stages',
  'csv.positive': 'Positive prompt',
  'csv.negative': 'Negative prompt',
  'csv.error': 'Error',
  'csv.category': 'Category',
  'csv.count': 'Count',
}

const dictionaries: Record<Locale, Record<DictKey, string>> = { zh, en }

function safeGetItem(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh'
  const langs = [...(navigator.languages ?? []), navigator.language].filter((l): l is string => !!l)
  // 无语言信号（测试环境等）回退中文；有英文信号才切英文
  return langs.some((l) => /^en/i.test(l)) ? 'en' : 'zh'
}

function initialLocale(): Locale {
  const stored = safeGetItem(LOCALE_KEY)
  return stored === 'en' || stored === 'zh' ? stored : detectLocale()
}

const LOCALE_KEY = 'cii:locale'

/** 当前语言（响应式）：模板 / computed 中经由 t() 读取即随切换重渲染 */
export const locale = ref<Locale>(initialLocale())

export function setLocale(l: Locale) {
  locale.value = l
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_KEY, l)
  } catch {
    // 配额 / 环境限制时忽略：仅影响下次刷新的还原
  }
}

export function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}

/** 当前语言的日期展示 locale（详情抽屉文件时间等） */
export function dateLocale(): string {
  return locale.value === 'en' ? 'en-US' : 'zh-CN'
}

/** 取词条并做 {name} 插值；key 由 DictKey 类型约束，拼写错误在编译期暴露 */
export function t(key: DictKey, params?: Record<string, string | number>): string {
  const template = dictionaries[locale.value][key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  )
}
