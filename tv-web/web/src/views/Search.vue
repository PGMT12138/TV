<!-- web/src/views/Search.vue -->
<template>
  <div style="padding: 20px;">
    <n-space vertical :size="16">
      <n-space>
        <n-button @click="$router.push('/')">返回</n-button>
        <n-input v-model:value="keyword" placeholder="搜索关键词" style="width: 300px;" @keydown.enter="search" />
        <n-button type="primary" :loading="loading" @click="search">搜索</n-button>
      </n-space>

      <n-spin :show="loading">
        <n-grid :cols="4" :x-gap="16" :y-gap="16">
          <n-gi v-for="vod in results" :key="vod._site + vod.vod_id">
            <VideoCard :vod="vod" @click="openDetail(vod)" />
          </n-gi>
        </n-grid>
      </n-spin>

      <n-empty v-if="!loading && results.length === 0 && searched" description="没有找到结果" />
    </n-space>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { NSpace, NButton, NInput, NGrid, NGi, NSpin, NEmpty } from 'naive-ui';
import VideoCard from '../components/VideoCard.vue';
import api from '../api/client.js';
import { useConfigStore } from '../stores/config.js';

const router = useRouter();
const store = useConfigStore();
const keyword = ref('');
const results = ref([]);
const loading = ref(false);
const searched = ref(false);

async function search() {
  if (!keyword.value.trim()) return;
  loading.value = true;
  searched.value = false;
  results.value = [];

  const sites = store.config?.sites.filter(s => s.searchable !== 0) || [];
  const promises = sites.map(async site => {
    try {
      const result = await api.search(store.configUrl, site.key, keyword.value.trim(), true);
      return (result.list || []).map(v => ({ ...v, _site: site.key, _siteName: site.name }));
    } catch { return []; }
  });

  const allResults = await Promise.all(promises);
  results.value = allResults.flat();
  searched.value = true;
  loading.value = false;
}

function openDetail(vod) {
  router.push({ path: '/detail', query: { site: vod._site, id: vod.vod_id } });
}
</script>
