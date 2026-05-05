<!-- web/src/components/VideoCard.vue -->
<template>
  <n-card size="small" hoverable @click="$emit('click')" style="cursor: pointer;">
    <template #cover>
      <img :src="imgUrl" style="height: 200px; object-fit: cover; background: #333;" loading="lazy" />
    </template>
    <n-ellipsis :line-clamp="1" style="font-weight: 500;">{{ vod.vod_name }}</n-ellipsis>
    <n-ellipsis :line-clamp="1" style="font-size: 12px; color: #999;">{{ vod.vod_remarks }}</n-ellipsis>
  </n-card>
</template>

<script setup>
import { computed } from 'vue';
import { NCard, NEllipsis } from 'naive-ui';
import api from '../api/client.js';

const props = defineProps({ vod: Object });
defineEmits(['click']);

const imgUrl = computed(() => api.imgUrl(props.vod.vod_pic));
</script>
