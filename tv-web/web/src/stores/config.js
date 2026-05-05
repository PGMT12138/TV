// web/src/stores/config.js
import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useConfigStore = defineStore('config', () => {
  const configUrl = ref(localStorage.getItem('tv_config_url') || '');
  const config = ref(null);
  const loading = ref(false);
  const error = ref('');

  async function loadConfig(url) {
    loading.value = true;
    error.value = '';
    try {
      configUrl.value = url;
      localStorage.setItem('tv_config_url', url);
      config.value = await api.loadConfig(url);
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
    } finally {
      loading.value = false;
    }
  }

  async function reloadConfig() {
    if (configUrl.value) await loadConfig(configUrl.value);
  }

  return { configUrl, config, loading, error, loadConfig, reloadConfig };
});
