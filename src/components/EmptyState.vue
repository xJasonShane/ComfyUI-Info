<script setup lang="ts">
import { NButton } from 'naive-ui'
import Icon from './Icon.vue'
import { openFilePickerRequest, openFolderPickerRequest } from '../composables/ui'
import { t } from '../locales'

defineProps<{ filtered: boolean; hiddenCount: number }>()
defineEmits<{ showAll: [] }>()
</script>

<template>
  <div class="empty">
    <div class="empty-frame"><Icon name="image" :size="40" :stroke="1.6" /></div>
    <template v-if="filtered">
      <h2>{{ t('empty.filtered') }}</h2>
      <p v-if="hiddenCount > 0" v-html="t('empty.hidden', { n: hiddenCount })" />
      <p v-else>{{ t('empty.adjust') }}</p>
      <button v-if="hiddenCount > 0" class="show-all" @click="$emit('showAll')">
        {{ t('empty.showAll', { n: hiddenCount }) }}
      </button>
    </template>
    <template v-else>
      <h2>{{ t('empty.dropTitle') }}</h2>
      <p v-html="t('empty.intro')" />
      <div class="empty-actions">
        <NButton type="primary" size="small" @click="openFilePickerRequest++">
          <template #icon><Icon name="image-plus" :size="14" /></template>
          {{ t('topbar.addImages') }}
        </NButton>
        <NButton size="small" secondary @click="openFolderPickerRequest++">
          <template #icon><Icon name="folder-plus" :size="14" /></template>
          {{ t('topbar.addFolder') }}
        </NButton>
      </div>
      <div class="chips">
        <span>{{ t('empty.chipLocal') }}</span>
        <span>{{ t('empty.chipFormats') }}</span>
        <span>{{ t('empty.chipSources') }}</span>
        <span>{{ t('empty.chipFiles') }}</span>
        <span>{{ t('empty.chipCopy') }}</span>
      </div>
    </template>
  </div>
</template>
