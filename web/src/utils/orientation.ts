// 移动设备判定与屏幕旋转控制。
// Screen Orientation API 的 lock() 仅在 Android/Chromium 的全屏状态下生效，
// iOS Safari 完全不支持——所有调用必须静默降级，桌面浏览器无影响。

export const isMobileDevice = () =>
  /Android|iPhone|iPad|Mobile|Silk/i.test(navigator.userAgent);

export type OrientationLock = 'landscape' | 'portrait';

export const lockOrientation = (orient: OrientationLock) => {
  try {
    const so = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    so?.lock?.(orient)?.catch?.(() => {});
  } catch {
    /* 不支持：保持系统自动旋转 */
  }
};

export const unlockOrientation = () => {
  try {
    screen.orientation?.unlock();
  } catch {
    /* ignore */
  }
};
