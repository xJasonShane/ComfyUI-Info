<script setup lang="ts">
import Icon from './Icon.vue'

defineProps<{ filtered: boolean; hiddenCount: number }>()
defineEmits<{ showAll: [] }>()
</script>

<template>
  <div class="empty">
    <div class="empty-frame"><Icon name="image" :size="40" :stroke="1.6" /></div>
    <template v-if="filtered">
      <h2>没有符合当前筛选的图片</h2>
      <p v-if="hiddenCount > 0">
        已解析的图片中有 <b>{{ hiddenCount }}</b> 张被来源 / 搜索 / 模型筛选隐藏。它们可能以
        A1111 兼容格式保存（ComfyUI 生态常见，拖回 ComfyUI 同样能自动转换成工作流）。
      </p>
      <p v-else>试试调整搜索关键词、模型或来源筛选，也可以直接拖入更多图片或文件夹。</p>
      <button v-if="hiddenCount > 0" class="show-all" @click="$emit('showAll')">
        查看全部 {{ hiddenCount }} 张
      </button>
    </template>
    <template v-else>
      <h2>把图片拖进来</h2>
      <p>
        支持<b>单张、多张或整个文件夹</b>（也可拖拽目录），自动扫描其中的 ComfyUI
        原图并读取内置元数据：提示词、模型、CFG、步数、种子、采样器等。所有解析都在本地浏览器完成，图片不会上传。
      </p>
      <div class="chips">
        <span>100% 本地解析</span>
        <span>PNG / JPEG / WebP</span>
        <span>ComfyUI · A1111</span>
        <span>一键复制提示词</span>
      </div>
    </template>
  </div>
</template>
