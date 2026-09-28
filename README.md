# ComfyUI·Info — ComfyUI 图片信息查看器

一个纯前端的本地工具：把 ComfyUI 生成的图片（单张、多张或整个文件夹）拖进来，自动扫描其中的 ComfyUI 原图，直接读取内置元数据——提示词、模型、CFG、步数、种子、采样器、LoRA 等信息一目了然。

**所有解析都在浏览器本地完成，图片不会上传到任何服务器。**

## 功能

- **三种添加方式**：单张 / 多张（文件选择器）、整个文件夹（递归扫描）、直接拖拽文件或文件夹到窗口
- **自动识别来源**：自动区分 ComfyUI 原图、A1111/WebUI 图片和无元数据的普通图片，默认只显示 ComfyUI 原图，可切换
- **完整参数解析**：
  - 正向 / 负向提示词（沿工作流连线自动回溯，兼容常见组合节点）
  - 模型（checkpoint / unet）、LoRA 及强度
  - 采样器、调度器、步数、CFG、种子（64 位大数不丢精度）、重绘幅度
  - 出图尺寸与批量张数
  - 多阶段采样（如高清修复两阶段）按节点顺序全部列出
- **工作流提取**：查看 / 复制 / 下载 Prompt JSON 和 UI 工作流 JSON，下载的 workflow.json 可直接拖回 ComfyUI 画布恢复工作流
- **筛选与搜索**：按模型筛选、按来源筛选、按提示词 / 文件名搜索
- **深色 / 浅色主题**，偏好自动记忆
- 支持格式：PNG（tEXt / zTXt / iTXt）、JPEG、WebP（EXIF UserComment）

## 使用

```bash
npm install
npm run dev       # 开发
npm run build     # 构建产物为单个 dist/index.html
npm run preview   # 预览构建产物
npm run test      # 解析器单元测试
```

`npm run build` 产出的是**单文件** `dist/index.html`（约 500 KB），直接双击即可在浏览器中离线使用，无需任何服务器。

## 技术栈

Vue 3 + TypeScript + Vite + Naive UI，零运行时依赖的元数据解析（自实现 PNG chunk 解析与 EXIF TIFF 解析，zlib 解压用浏览器原生 `DecompressionStream`）。

## 元数据存储原理（参考）

- **PNG**：ComfyUI 通过 PIL 把 `prompt`（API 格式工作流 JSON）和 `workflow`（UI 格式工作流 JSON）写入 `tEXt` / `iTXt` 块，含非 Latin-1 字符（如中文）时 PIL 自动改用 zlib 压缩的 `iTXt`
- **JPEG / WebP**：prompt JSON 写入 EXIF 的 `UserComment`（0x9286）；A1111 的 `parameters` 文本同样在此
- 解析时只读取文件头部切片（元数据位于图像数据之前），扫描大量图片也很快

## 项目结构

```
src/
  lib/
    png.ts          # PNG tEXt / zTXt / iTXt 块解析
    exif.ts         # JPEG APP1 / WebP RIFF 的 EXIF UserComment 解析
    metadata.ts     # 解析入口 + 来源判定
    comfyExtract.ts # ComfyUI 工作流 → 结构化参数
    a1111.ts        # A1111 parameters 文本解析
    utils.ts        # 剪贴板 / 下载 / 格式化
  composables/
    store.ts        # 图片库状态 + 并发解析队列 + 筛选
  components/
    TopBar.vue      # 添加 / 搜索 / 筛选 / 主题
    ImageCard.vue   # 画廊卡片
    DetailDrawer.vue# 大图 + 元数据详情
    EmptyState.vue  # 空状态引导
scripts/
  make-fixtures.mjs # 生成带元数据的测试图片
tests/
  parse.test.ts     # 解析器单元测试（19 例）
```
