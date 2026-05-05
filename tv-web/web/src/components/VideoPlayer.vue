<!-- web/src/components/VideoPlayer.vue -->
<template>
  <div ref="containerRef" style="width: 100%; background: #000; position: relative;">
    <video ref="videoRef" style="width: 100%; max-height: 80vh;" controls autoplay />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import Hls from 'hls.js';

const props = defineProps({ url: String, headers: Object });
const videoRef = ref(null);
const containerRef = ref(null);
let hls = null;

function destroy() {
  if (hls) { hls.destroy(); hls = null; }
}

function loadVideo() {
  destroy();
  const video = videoRef.value;
  if (!video || !props.url) return;

  const isHls = props.url.includes('.m3u8') || props.url.includes('m3u8');
  const isDash = props.url.includes('.mpd') || props.url.includes('dash');

  if (isHls && Hls.isSupported()) {
    hls = new Hls({
      xhrSetup: (xhr) => {
        if (props.headers) {
          for (const [k, v] of Object.entries(props.headers)) {
            xhr.setRequestHeader(k, v);
          }
        }
      }
    });
    hls.loadSource(props.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
  } else if (video.canPlayType('application/vnd.apple.mpegurl') && isHls) {
    video.src = props.url;
    video.play();
  } else {
    video.src = props.url;
    video.play();
  }
}

watch(() => props.url, loadVideo);
onMounted(loadVideo);
onBeforeUnmount(destroy);
</script>
