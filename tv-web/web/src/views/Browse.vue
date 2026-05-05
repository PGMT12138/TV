<!-- web/src/views/Browse.vue -->
<template>
  <div style="padding: 20px;">
    <n-space vertical :size="16">
      <n-space>
        <n-button @click="$router.push('/')">返回</n-button>
        <h3>{{ siteName }}</h3>
      </n-space>

      <n-space v-if="categories.length">
        <n-tag v-for="cat in categories" :key="cat.type_id"
          :type="currentTid === cat.type_id ? 'primary' : 'default'"
          style="cursor: pointer;" @click="selectCategory(cat)">
          {{ cat.type_name }}
        </n-tag>
      </n-space>

      <n-spin :show="loading">
        <n-grid :cols="4" :x-gap="16" :y-gap="16">
          <n-gi v-for="vod in videoList" :key="vod.vod_id">
            <VideoCard :vod="vod" @click="openDetail(vod)" />
          </n-gi>
        </n-grid>
      </n-spin>

      <n-space v-if="pageCount > 1" justify="center">
        <n-button :disabled="page <= 1" @click="page--; loadCategory()">上一页</n-button>
        <span style="line-height: 34px;">{{ page }} / {{ pageCount }}</span>
        <n-button :disabled="page >= pageCount" @click="page++; loadCategory()">下一页</n-button>
      </n-space>
    </n-space>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NSpace, NButton, NTag, NGrid, NGi, NSpin } from 'naive-ui';
import VideoCard from '../components/VideoCard.vue';
import api from '../api/client.js';
import { useConfigStore } from '../stores/config.js';

const route = useRoute();
const router = useRouter();
const store = useConfigStore();

const siteKey = route.query.site;
const siteName = store.config?.sites.find(s => s.key === siteKey)?.name || siteKey;
const configUrl = store.configUrl;

const categories = ref([]);
const currentTid = ref('');
const videoList = ref([]);
const loading = ref(false);
const page = ref(1);
const pageCount = ref(1);

async function selectCategory(cat) {
  currentTid.value = cat.type_id;
  page.value = 1;
  await loadCategory();
}

async function loadCategory() {
  loading.value = true;
  try {
    const result = await api.category(configUrl, siteKey, currentTid.value, page.value);
    videoList.value = result.list || [];
    pageCount.value = result.pagecount || 1;
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

async function loadHome() {
  loading.value = true;
  try {
    const homeResult = await api.home(configUrl, siteKey);
    categories.value = homeResult.class || [];
    if (categories.value.length > 0) {
      currentTid.value = categories.value[0].type_id;
    }

    const vodResult = await api.homeVod(configUrl, siteKey);
    videoList.value = vodResult.list || [];
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
}

function openDetail(vod) {
  router.push({ path: '/detail', query: { site: siteKey, id: vod.vod_id } });
}

onMounted(loadHome);
</script>
