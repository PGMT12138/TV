<!-- web/src/views/Detail.vue -->
<template>
  <div style="padding: 20px;">
    <n-space vertical :size="16" v-if="vod">
      <n-button @click="$router.back()">返回</n-button>

      <n-card>
        <n-grid :cols="2" :x-gap="24">
          <n-gi>
            <img :src="api.imgUrl(vod.vod_pic)" style="width: 100%; border-radius: 8px;" />
          </n-gi>
          <n-gi>
            <h2>{{ vod.vod_name }}</h2>
            <p v-if="vod.vod_year">年份: {{ vod.vod_year }}</p>
            <p v-if="vod.vod_area">地区: {{ vod.vod_area }}</p>
            <p v-if="vod.vod_director">导演: {{ vod.vod_director }}</p>
            <p v-if="vod.vod_actor">演员: {{ vod.vod_actor }}</p>
            <n-ellipsis :line-clamp="4">{{ vod.vod_content }}</n-ellipsis>
          </n-gi>
        </n-grid>
      </n-card>

      <n-tabs v-if="flags.length" type="segment" @update:value="onFlagChange">
        <n-tab v-for="flag in flags" :key="flag" :name="flag">{{ flag }}</n-tab>
      </n-tabs>

      <n-space wrap>
        <n-button v-for="ep in currentEpisodes" :key="ep.name"
          :type="selectedEp === ep.name ? 'primary' : 'default'"
          @click="play(ep)">
          {{ ep.name }}
        </n-button>
      </n-space>
    </n-space>

    <n-spin :show="loading" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NSpace, NButton, NCard, NGrid, NGi, NEllipsis, NTabs, NTab, NSpin } from 'naive-ui';
import api from '../api/client.js';
import { useConfigStore } from '../stores/config.js';

const route = useRoute();
const router = useRouter();
const store = useConfigStore();

const configUrl = store.configUrl;
const siteKey = route.query.site;
const vodId = route.query.id;

const vod = ref(null);
const loading = ref(false);
const selectedFlag = ref('');
const selectedEp = ref('');

const flags = computed(() => {
  if (!vod.value?.vod_play_from) return [];
  return vod.value.vod_play_from.split('$$$').filter(Boolean);
});

const currentEpisodes = computed(() => {
  if (!vod.value?.vod_play_url) return [];
  const groups = vod.value.vod_play_url.split('$$$');
  const idx = flags.value.indexOf(selectedFlag.value);
  if (idx < 0 || idx >= groups.length) return [];
  return groups[idx].split('#').map(ep => {
    const parts = ep.split('$');
    return { name: parts[0] || '播放', url: parts[1] || '' };
  }).filter(ep => ep.url);
});

function onFlagChange(flag) {
  selectedFlag.value = flag;
  selectedEp.value = '';
}

function play(ep) {
  selectedEp.value = ep.name;
  router.push({
    path: '/player',
    query: { site: siteKey, flag: selectedFlag.value, id: ep.url }
  });
}

onMounted(async () => {
  loading.value = true;
  try {
    const result = await api.detail(configUrl, siteKey, vodId);
    vod.value = result.list?.[0] || null;
    if (flags.value.length > 0) selectedFlag.value = flags.value[0];
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
});
</script>
