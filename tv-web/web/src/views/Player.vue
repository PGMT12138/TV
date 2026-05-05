<!-- web/src/views/Player.vue -->
<template>
  <div style="padding: 20px;">
    <n-space vertical :size="16">
      <n-button @click="$router.back()">返回</n-button>
      <VideoPlayer v-if="playUrl" :url="playUrl" :headers="playHeaders" />
      <n-alert v-if="error" type="error" :title="error" />
    </n-space>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { NSpace, NButton, NAlert } from 'naive-ui';
import VideoPlayer from '../components/VideoPlayer.vue';
import api from '../api/client.js';
import { useConfigStore } from '../stores/config.js';

const route = useRoute();
const store = useConfigStore();

const playUrl = ref('');
const playHeaders = ref({});
const error = ref('');

onMounted(async () => {
  try {
    const result = await api.play(
      store.configUrl, route.query.site,
      route.query.flag, route.query.id
    );

    if (result.url) {
      playUrl.value = result.url;
      playHeaders.value = result.header || {};
    } else {
      error.value = result.msg || '无法获取播放地址';
    }
  } catch (e) {
    error.value = e.message;
  }
});
</script>
