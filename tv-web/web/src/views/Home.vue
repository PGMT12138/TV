<!-- web/src/views/Home.vue -->
<template>
  <div style="max-width: 800px; margin: 40px auto; padding: 0 20px;">
    <h1 style="text-align: center; margin-bottom: 30px;">TV Web Player</h1>

    <n-space vertical :size="16">
      <n-input-group>
        <n-input v-model:value="inputUrl" placeholder="输入配置地址 (TVBox JSON URL)" size="large" clearable />
        <n-button type="primary" size="large" :loading="store.loading" @click="load">加载</n-button>
      </n-input-group>

      <n-alert v-if="store.error" type="error" :title="store.error" />

      <template v-if="store.config">
        <n-space justify="space-between">
          <n-divider style="margin: 0;">点播源 ({{ store.config.sites.length }})</n-divider>
          <n-button @click="$router.push('/search')">搜索</n-button>
        </n-space>
        <n-grid :cols="2" :x-gap="12" :y-gap="12">
          <n-gi v-for="site in store.config.sites" :key="site.key">
            <n-card size="small" hoverable @click="openSite(site)">
              {{ site.name }}
              <template #header-extra>
                <n-tag size="small" type="info">{{ site.type }}</n-tag>
              </template>
            </n-card>
          </n-gi>
        </n-grid>

        <template v-if="store.config.lives.length > 0">
          <n-divider>直播源 ({{ store.config.lives.length }})</n-divider>
          <n-grid :cols="2" :x-gap="12" :y-gap="12">
            <n-gi v-for="live in store.config.lives" :key="live.name">
              <n-card size="small" hoverable @click="openLive(live)">
                {{ live.name }}
              </n-card>
            </n-gi>
          </n-grid>
        </template>
      </template>
    </n-space>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { NInputGroup, NInput, NButton, NSpace, NCard, NGrid, NGi, NDivider, NTag, NAlert } from 'naive-ui';
import { useConfigStore } from '../stores/config.js';

const router = useRouter();
const store = useConfigStore();
const inputUrl = ref(store.configUrl);

function load() {
  if (inputUrl.value.trim()) store.loadConfig(inputUrl.value.trim());
}

function openSite(site) {
  router.push({ path: '/browse', query: { site: site.key } });
}

function openLive(live) {
  router.push({ path: '/live', query: { name: live.name } });
}

onMounted(() => {
  if (store.configUrl) load();
});
</script>
