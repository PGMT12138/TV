// web/src/main.js
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Home.vue') },
    { path: '/browse', component: () => import('./views/Browse.vue') },
    { path: '/detail', component: () => import('./views/Detail.vue') },
    { path: '/player', component: () => import('./views/Player.vue') },
    { path: '/search', component: () => import('./views/Search.vue') },
    { path: '/live', component: () => import('./views/Live.vue') }
  ]
});

createApp(App).use(createPinia()).use(router).mount('#app');
