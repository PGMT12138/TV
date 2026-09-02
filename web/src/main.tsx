import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// 触控模拟环境（如 ZCode 内嵌浏览器）自报 hover:none，Tailwind 的悬停样式被 (hover:hover)
// 门控整体失效（见 index.css 的 @custom-variant）；检测到真实鼠标后在 <html> 加 has-mouse 解锁。
// 桌面浏览器（hover:hover + pointer:fine）启动即解锁；其余环境等首次鼠标指针事件再解锁。
(function () {
  const unlock = () => document.documentElement.classList.add('has-mouse');
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return unlock();
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    window.removeEventListener('pointermove', onPointer, true);
    window.removeEventListener('pointerdown', onPointer, true);
    unlock();
  };
  window.addEventListener('pointermove', onPointer, true);
  window.addEventListener('pointerdown', onPointer, true);
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
