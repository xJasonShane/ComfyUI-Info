# ComfyUI·Info — ComfyUI 图片信息查看器

一个纯前端的本地工具：把 AI 生图（单张、多张或整个文件夹）拖进来，自动扫描其中的 ComfyUI 原图和 A1111/WebUI 格式图片，直接读取内置元数据——提示词、模型、CFG、步数、种子、采样器、LoRA 等信息一目了然。

**所有解析都在浏览器本地完成，图片不会上传到任何服务器。**

## 功能

- **三种添加方式**：单张 / 多张（文件选择器）、整个文件夹（递归扫描）、直接拖拽文件或文件夹到窗口；目录内文件的相对路径会被保留，用于去重、展示与导出溯源（不同子目录下的同名文件不会被误去重）；无扩展名 / 生僻扩展名的图片按文件头魔数自动识别；Chromium 系浏览器的目录选择走 File System Access API，会记住目录供一键重扫
- **一键重扫**：记住上次扫描的目录后，顶栏「重扫」按钮增量更新——只添加新文件，已有图片按指纹回挂去重，不会重复解析；权限需重新授权时自动弹窗
- **自动识别来源**：自动区分 ComfyUI 原图、A1111/WebUI 图片和无元数据的普通图片，默认只显示 ComfyUI 原图，可一键切换
- **A1111 兼容格式支持**：ComfyUI 生态的 Civitai 兼容保存节点（Image Saver 等）和在线平台导出的图，参数以 A1111 文本格式存储——同样完整解析，含 `<lora:…>` 标签、Lora hashes 与高清修复两阶段；若参数文本尾部内嵌了 workflow JSON，会自动升级按 ComfyUI 工作流解析
- **完整参数解析**：
  - 正向 / 负向提示词（ComfyUI 沿工作流连线自动回溯，兼容常见组合节点）
  - 模型（checkpoint / unet）、LoRA 及强度
  - 采样器、调度器、步数、CFG、种子（64 位大数不丢精度）、重绘幅度
  - 出图尺寸与批量张数
  - 多阶段采样（如高清修复两阶段）按节点顺序全部列出
- **工作流提取**：查看 / 复制 / 下载 Prompt JSON 和 UI 工作流 JSON，下载的 workflow.json 可直接拖回 ComfyUI 画布恢复工作流
- **筛选与搜索**：按模型筛选、按来源筛选、按提示词 / 文件名与路径 / 模型 / LoRA（含哈希）/ 采样参数搜索，支持结构化语法 `model:xxx`、`lora:xxx`、`seed:123`、`path:目录`（可与普通关键词多条件组合，按 AND 匹配）；可切换按文件时间新→旧 / 旧→新排序（扫描输出目录时即生成顺序，失败项始终靠后），偏好自动记忆；筛选结果为空时提示被隐藏的数量并支持一键查看全部
- **参数对比**：多选两张已解析图片即可并排对比模型 / 采样参数（多阶段逐项对齐）/ LoRA / 提示词，差异项高亮，便于定位两次出图之间的参数变化
- **移除与导出**：卡片悬停可单张移除（同步回收预览内存）；支持 Ctrl / ⌘+点击多选、Shift+点击区间选择（或 Ctrl+空格切换选中），浮动操作条提供全选筛选结果、批量移除、批量复制正向提示词与导出选中；当前筛选结果一键导出 JSON / CSV（含相对路径列，CSV 带 BOM 可直接用 Excel 打开）或把全部工作流打包为 ZIP（按相对路径存放 prompt / workflow / 参数文本 + manifest），便于数据集整理与批量分析
- **无元数据诊断**：识别不出参数时，详情页显示检测线索（如「包含 Adobe XMP 编辑信息，生成参数已被 Photoshop 处理清除」），一眼看出原因；元数据存在但解析失败（如内嵌工作流 JSON 被截断损坏）时会单独提示，原始 JSON 仍可查看 / 复制用于排查
- **解析失败可见**：损坏或读取失败的文件不会被静默忽略——统计区显示失败数量（点击直达），来源筛选可切换到「解析失败」，详情页展示错误原因并支持一键重试
- **会话持久化**：解析结果（来源、参数、诊断信息、失败原因）自动存入浏览器 IndexedDB，仅存本机、不含图片本体；刷新或关闭后重新打开，历史记录仍在并标记「已存档」，把原文件重新拖入即按指纹自动回挂预览，无需重新扫描；清空列表会连历史记录一起清除
- **深色 / 浅色主题**，偏好自动记忆
- **键盘可操作**：Tab 聚焦卡片，Enter / 空格打开详情；抽屉内 ← / → 按当前筛选顺序浏览、Esc 关闭，关闭后焦点返还来源卡片
- 支持格式：PNG（tEXt / zTXt / iTXt / eXIf 块）、JPEG、WebP（EXIF UserComment）

## 使用

```bash
npm install
npm run dev       # 开发（默认 http://localhost:5173）
npm run build     # 构建产物为单个 dist/index.html（含 vue-tsc 类型检查）
npm run preview   # 预览构建产物
npm run test      # 单元测试（解析器 / store / 导出 / 工具）
npm run lint      # ESLint 检查
npm run format    # Prettier 格式化（format:check 只校验不写入）
```

GitHub Actions 在 push / PR 时自动执行 lint + 单测 + 构建。

`npm run build` 产出的是**单文件** `dist/index.html`（约 590 KB），直接双击即可在浏览器中离线使用，无需任何服务器。

解析结果会自动持久化到浏览器的 IndexedDB（图片本体不入库，数据不出本机）：刷新或关闭后重新打开，历史记录以「已存档」卡片显示，参数照常查看、搜索与导出；把原文件重新拖入即按指纹自动回挂预览。IndexedDB 不可用的环境（部分 file:// 场景、隐私模式等）会在启动时探测并自动降级为纯内存模式，行为与旧版一致。清空列表会连历史记录一起清除。

## 常见问题

**Q：ComfyUI 生成的图为什么被标成"A1111"？**

这批图的元数据是 A1111 兼容格式（常见于 Image Saver 等 Civitai 兼容保存节点、部分在线平台导出）。判断依据很直接：把这类图拖回 ComfyUI 时走的正是"读取 A1111 参数 → 自动转换工作流"的路径。无论哪种格式，提示词、步数、CFG、种子等参数都会完整解析展示，只是来源标签不同。

**Q：为什么显示"无元数据"？**

只有生图软件直接输出的原图才带参数。图片经过 Photoshop / Lightroom 处理、微信 / QQ 传输或网页转存后，生成参数通常会被剥离。此时详情页会显示具体检测线索（检测到的文本块、EXIF 软件字段等），帮助判断原因。

**Q：想只看某一类图？**

右上角来源筛选可切换 ComfyUI 原图 / A1111 / 无元数据 / 全部；配合模型筛选和搜索可以精确定位（比如搜某个模型名、LoRA 名称、种子或提示词片段）。

## 技术栈

Vue 3 + TypeScript + Vite + Naive UI，零运行时依赖的元数据解析（自实现 PNG chunk 解析与 EXIF TIFF 解析，zlib 解压用浏览器原生 `DecompressionStream`）。解析跑在 Web Worker 池里（按硬件线程数建 1-4 个），批量扫描时主线程只等结果不参与计算；Worker 不可用的环境（如部分 `file://` 直接打开的场景）自动整体回退到主线程解析，行为一致。解析结果通过 IndexedDB 持久化（启动时以真实读写探测可用性，不可用即降级纯内存），Worker 池与回退编排以可注入传输实现并有独立单测。

## 元数据存储原理（参考）

- **PNG**：ComfyUI 通过 PIL 把 `prompt`（API 格式工作流 JSON）和 `workflow`（UI 格式工作流 JSON）写入 `tEXt` / `iTXt` 块，含非 Latin-1 字符（如中文）时 PIL 自动改用 zlib 压缩的 `iTXt`
- **JPEG / WebP**：EXIF `UserComment`（0x9286）；A1111 的 `parameters` 文本同样在此（ComfyUI 内置节点只输出带元数据的 PNG，JPEG/WebP 需要自定义保存节点）
- 解析时只读取文件头部切片（PNG / JPEG 的元数据位于图像数据之前），并按 256KB → 4MB → 整文件逐级放大，绝大多数文件一次小切片即可命中，扫描大量图片也很快；WebP 的 EXIF / XMP 块位于图像数据之后，解析器依 VP8X 标志对头部未命中的大文件逐级补扫
- 同一工作流批量出图的 prompt / workflow JSON 在主线程接收处做去重合并（interning），长列表常驻内存显著降低

> **提示**：`tests/fixtures/` 内有各类样例（ComfyUI tEXt / iTXt 中文 / 两阶段工作流 / A1111 / Photoshop 处理图 / 真实 ComfyUI 输出），`npm run test` 可验证解析器行为。

## 项目结构

```
src/
  lib/
    png.ts          # PNG tEXt / zTXt / iTXt 块解析
    exif.ts         # JPEG APP1 / WebP RIFF 的 EXIF UserComment 解析 + XMP 检测
    metadata.ts     # 解析入口 + 来源判定 + 无元数据诊断线索
    comfyExtract.ts # ComfyUI 工作流 → 结构化参数
    a1111.ts        # A1111 parameters 文本解析
    parser.ts       # 解析调度：Worker 池 + 主线程兜底（传输可注入，含回退单测）
    parseWorker.ts  # 后台解析线程入口
    persist.ts      # 会话持久化（IndexedDB）：可用性探测 + 存档读写 + 目录句柄
    fs.ts           # File System Access：目录选择 / 权限 / 递归枚举（Chromium 系）
    export.ts       # 筛选结果导出（JSON / CSV / 工作流 ZIP 打包）
    utils.ts        # 剪贴板 / 下载 / 格式化
  composables/
    store.ts        # 图片库状态 + 并发解析队列 + 筛选
  components/
    TopBar.vue      # 添加 / 搜索 / 筛选 / 重扫 / 主题
    ImageCard.vue   # 画廊卡片（多选 / 存档态）
    DetailDrawer.vue# 大图 + 元数据详情 + 诊断提示
    CompareDrawer.vue# 双栏参数对比（差异高亮）
    EmptyState.vue  # 空状态 + 筛选引导
scripts/
  make-fixtures.mjs # 生成带元数据的测试图片
tests/
  parse.test.ts     # 解析器 / Worker 池回退 / 嗅探单元测试
  store.test.ts     # store：队列竞态 / 去重 / 回挂 / 搜索语法
  export.test.ts    # 导出 JSON / CSV / ZIP
```
