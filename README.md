# ComfyUI·Info — ComfyUI 图片信息查看器

一个纯前端的本地工具：把 AI 生图（单张、多张或整个文件夹）拖进来，自动扫描其中的 ComfyUI 原图和 A1111/WebUI 格式图片，直接读取内置元数据——提示词、模型、CFG、步数、种子、采样器、LoRA 等信息一目了然。

**所有解析都在浏览器本地完成，图片不会上传到任何服务器。**

## 功能

- **三种添加方式**：单张 / 多张（文件选择器）、整个文件夹（递归扫描）、直接拖拽文件或文件夹到窗口
- **自动识别来源**：自动区分 ComfyUI 原图、A1111/WebUI 图片和无元数据的普通图片，默认只显示 ComfyUI 原图，可一键切换
- **A1111 兼容格式支持**：ComfyUI 生态的 Civitai 兼容保存节点（Image Saver 等）和在线平台导出的图，参数以 A1111 文本格式存储——同样完整解析，含 `<lora:…>` 标签、Lora hashes 与高清修复两阶段；若参数文本尾部内嵌了 workflow JSON，会自动升级按 ComfyUI 工作流解析
- **完整参数解析**：
  - 正向 / 负向提示词（ComfyUI 沿工作流连线自动回溯，兼容常见组合节点）
  - 模型（checkpoint / unet）、LoRA 及强度
  - 采样器、调度器、步数、CFG、种子（64 位大数不丢精度）、重绘幅度
  - 出图尺寸与批量张数
  - 多阶段采样（如高清修复两阶段）按节点顺序全部列出
- **工作流提取**：查看 / 复制 / 下载 Prompt JSON 和 UI 工作流 JSON，下载的 workflow.json 可直接拖回 ComfyUI 画布恢复工作流
- **筛选与搜索**：按模型筛选、按来源筛选、按提示词 / 文件名 / 模型 / LoRA（含哈希）/ 采样参数搜索；筛选结果为空时提示被隐藏的数量并支持一键查看全部
- **无元数据诊断**：识别不出参数时，详情页显示检测线索（如「包含 Adobe XMP 编辑信息，生成参数已被 Photoshop 处理清除」），一眼看出原因
- **解析失败可见**：损坏或读取失败的文件不会被静默忽略——统计区显示失败数量（点击直达），来源筛选可切换到「解析失败」，详情页展示错误原因并支持一键重试
- **深色 / 浅色主题**，偏好自动记忆
- 支持格式：PNG（tEXt / zTXt / iTXt / eXIf 块）、JPEG、WebP（EXIF UserComment）

## 使用

```bash
npm install
npm run dev       # 开发（默认 http://localhost:5173）
npm run build     # 构建产物为单个 dist/index.html
npm run preview   # 预览构建产物
npm run test      # 解析器单元测试
```

`npm run build` 产出的是**单文件** `dist/index.html`（约 530 KB），直接双击即可在浏览器中离线使用，无需任何服务器。

图片列表保存在浏览器内存中，刷新页面后需要重新添加（有已加载图片时，刷新或关闭前浏览器会弹出确认）。

## 常见问题

**Q：ComfyUI 生成的图为什么被标成"A1111"？**

这批图的元数据是 A1111 兼容格式（常见于 Image Saver 等 Civitai 兼容保存节点、部分在线平台导出）。判断依据很直接：把这类图拖回 ComfyUI 时走的正是"读取 A1111 参数 → 自动转换工作流"的路径。无论哪种格式，提示词、步数、CFG、种子等参数都会完整解析展示，只是来源标签不同。

**Q：为什么显示"无元数据"？**

只有生图软件直接输出的原图才带参数。图片经过 Photoshop / Lightroom 处理、微信 / QQ 传输或网页转存后，生成参数通常会被剥离。此时详情页会显示具体检测线索（检测到的文本块、EXIF 软件字段等），帮助判断原因。

**Q：想只看某一类图？**

右上角来源筛选可切换 ComfyUI 原图 / A1111 / 无元数据 / 全部；配合模型筛选和搜索可以精确定位（比如搜某个模型名、LoRA 名称、种子或提示词片段）。

## 技术栈

Vue 3 + TypeScript + Vite + Naive UI，零运行时依赖的元数据解析（自实现 PNG chunk 解析与 EXIF TIFF 解析，zlib 解压用浏览器原生 `DecompressionStream`）。

## 元数据存储原理（参考）

- **PNG**：ComfyUI 通过 PIL 把 `prompt`（API 格式工作流 JSON）和 `workflow`（UI 格式工作流 JSON）写入 `tEXt` / `iTXt` 块，含非 Latin-1 字符（如中文）时 PIL 自动改用 zlib 压缩的 `iTXt`
- **JPEG / WebP**：EXIF `UserComment`（0x9286）；A1111 的 `parameters` 文本同样在此（ComfyUI 内置节点只输出带元数据的 PNG，JPEG/WebP 需要自定义保存节点）
- 解析时只读取文件头部切片（PNG / JPEG 的元数据位于图像数据之前），扫描大量图片也很快；WebP 的 EXIF / XMP 块位于图像数据之后，解析器依 VP8X 标志对头部未命中的大文件做一次整文件补扫

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
    utils.ts        # 剪贴板 / 下载 / 格式化
  composables/
    store.ts        # 图片库状态 + 并发解析队列 + 筛选
  components/
    TopBar.vue      # 添加 / 搜索 / 筛选 / 主题
    ImageCard.vue   # 画廊卡片
    DetailDrawer.vue# 大图 + 元数据详情 + 诊断提示
    EmptyState.vue  # 空状态 + 筛选引导
scripts/
  make-fixtures.mjs # 生成带元数据的测试图片
tests/
  parse.test.ts     # 解析器单元测试（20 例）
```
