<!-- web/src/views/Live.vue -->
<template>
  <div style="padding: 20px;">
    <n-space vertical :size="16">
      <n-button @click="$router.push('/')">返回</n-button>

      <n-grid :cols="4" :x-gap="16">
        <n-gi :span="1">
          <n-menu :options="groupMenu" @update:value="selectGroup" />
        </n-gi>
        <n-gi :span="1">
          <n-list bordered>
            <n-list-item v-for="ch in currentChannels" :key="ch.name"
              style="cursor: pointer;" :class="{ 'n-item--active': selectedChannel === ch.name }"
              @click="playChannel(ch)">
              {{ ch.name }}
            </n-list-item>
          </n-list>
        </n-gi>
        <n-gi :span="2">
          <VideoPlayer v-if="channelUrl" :url="channelUrl" />
          <n-empty v-else description="选择一个频道" />
        </n-gi>
      </n-grid>
    </n-space>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { NSpace, NButton, NGrid, NGi, NMenu, NList, NListItem, NEmpty } from 'naive-ui';
import VideoPlayer from '../components/VideoPlayer.vue';
import api from '../api/client.js';
import { useConfigStore } from '../stores/config.js';

const route = useRoute();
const store = useConfigStore();

const groups = ref([]);
const selectedGroup = ref('');
const selectedChannel = ref('');
const channelUrl = ref('');

const groupMenu = computed(() =>
  groups.value.map(g => ({ label: g.name, key: g.name }))
);

const currentChannels = computed(() => {
  const g = groups.value.find(g => g.name === selectedGroup.value);
  return g?.channel || [];
});

function selectGroup(name) {
  selectedGroup.value = name;
  selectedChannel.value = '';
  channelUrl.value = '';
}

function playChannel(ch) {
  selectedChannel.value = ch.name;
  channelUrl.value = ch.urls?.[0] || '';
}

onMounted(async () => {
  try {
    groups.value = await api.live(store.configUrl, route.query.name);
    if (groups.value.length > 0) selectedGroup.value = groups.value[0].name;
  } catch (e) {
    console.error(e);
  }
});
</script>
