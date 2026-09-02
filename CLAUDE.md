# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TV is an open-source Android media streaming app (package `com.fongmi.android.tv`) based on the CatVod spider framework. It produces two APK variants — **leanback** (Android TV/D-pad) and **mobile** (phone/touch) — from a shared codebase. A companion **manage/** Python FastAPI backend provides URL management, version updates, and a web dashboard.

## Build Commands

### Android (Gradle)

```bash
# Build all release APKs
# IMPORTANT: Must use --no-daemon -Dorg.gradle.jvmargs="-Xmx1500m -XX:+UseParallelGC" to limit heap to 1.5G
./gradlew assembleRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx1500m -XX:+UseParallelGC"

# Build specific variants
./gradlew assembleMobileArm64_v8aRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx1500m -XX:+UseParallelGC"
./gradlew assembleLeanbackArm64_v8aRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx1500m -XX:+UseParallelGC"

# Clean
./gradlew clean
```

Release APKs are named `{mode}-{abi}.apk` (e.g., `leanback-arm64_v8a.apk`). Signing config comes from `local.properties` (gitignored): set `storeFile`, `keyAlias`, `keyPassword`, `storePassword`.

No test suite exists.

### APK Deployment

构建后将 APK 复制到 nginx 已配置的静态文件目录：

```bash
sudo cp app/build/outputs/apk/leanbackArm64_v8a/release/leanback-arm64_v8a.apk /var/www/tv-apk/
sudo cp app/build/outputs/apk/mobileArm64_v8a/release/mobile-arm64_v8a.apk /var/www/tv-apk/
```

nginx 已配置 `/apk/` 路径指向 `/var/www/tv-apk/`，APK 可通过 `/apk/{mode}-{abi}.apk` 下载。

### manage (Python FastAPI)

```bash
cd manage
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --root-path /tv-manage --ws-ping-interval 20 --ws-ping-timeout 60
```

注意：Windows 本机 8000 端口常在系统保留段（`netsh interface ipv4 show excludedportrange protocol=tcp`），本地测试固定用 8100。`--ws-ping-timeout 60` 是必须的：智能选源扫描时设备爬虫（QuickJS/Chaquopy）高负载会拖慢 WebSocket 心跳响应，uvicorn 默认 20s 超时会掐断桥接。

### web (CINE 视频站前端)

```bash
cd web
npm install
npm run build    # 产物输出到 manage/static/cine（gitignored），由 FastAPI 挂载在 /cine
npm run dev      # 开发热更，/api /stream /ws 代理到 127.0.0.1:8100
```

## Architecture

### Gradle Modules (settings.gradle)

| Module | Purpose |
|--------|---------|
| `app` | Main Android application — UI, player, DB, server |
| `catvod` | Spider interface + OkHttp networking (used by all spider types) |
| `quickjs` | QuickJS JavaScript engine wrapper for JS spiders |
| `chaquo` | Chaquopy Python runtime for Python spiders |

6 additional directories (`forcetech/`, `hook/`, `jianpian/`, `thunder/`, `tvbus/`, `zlive/`) have `build.gradle` files but are **not** included in `settings.gradle`.

### Android Source Sets

- **`app/src/main/`** — Shared business logic: API layer (`api/`), data models (`bean/`), Room DB (`db/`), ExoPlayer/Media3 playback (`player/`), NanoHTTPD local server (`server/`), utilities
- **`app/src/leanback/`** — Android TV UI: Leanback activities, DLNA DMR (renderer), boot receiver
- **`app/src/mobile/`** — Phone UI: touch fragments, DLNA DMC (caster), ZXing QR scanner

The two UI flavors share all logic in `main/` but have completely separate UI layers. Leanback uses `androidx.leanback` patterns; mobile uses standard touch-based fragments.

### Spider System

The app loads external crawlers (spiders) at runtime through a unified `Spider` interface defined in `catvod/`. Three runtime engines are supported:

- **Java JARs** — loaded via DexClassLoader
- **JavaScript** — executed in QuickJS sandbox
- **Python** — executed via Chaquopy

Spider lifecycle: `init` → `homeContent` → `homeVideoContent` → `categoryContent` → `detailContent` → `searchContent` → `playerContent` → `destroy`. See `docs/SPIDER.md` for the full API spec.

### Configuration

VOD and Live TV are configured via external JSON files. See `docs/CONFIG.md` for the full schema. Key config fields: `sites` (spider sources), `parses` (extractors), `lives` (live TV sources), `doh`, `proxy`, `rules`.

### manage Backend

Python FastAPI app in `manage/`:
- **app.py** — REST API endpoints for URL management, app version updates (`/api/update/{platform}`), home content caching, video history/bookmarks
- **database.py** — SQLite layer with tables: `urls`, `app_versions`, `home_contents`, `videos`, CINE tables (`users`, `sessions`, `subjects`, `sections`, `section_items`, `favorites`, `history`), 智能选源 tables (`probe_cache`, `site_stats`)
- **bridge.py** — 设备 WebSocket 桥（`/ws`）+ 网页观看 API（`/api/sites|home|category|search|detail|player`）+ `/stream` 视频流代理（via=0 直连回源 / via=1 经设备转发）
- **catalog.py** — CINE 片库：豆瓣 rexxar 抓取（`subject_collection` 榜单 + `recommend` 高分 + `search/subjects` 搜索 + 详情补全），subjects/sections 全量缓存，12h 定时刷新（stale-while-revalidate，豆瓣被反爬时照常出缓存）；TMDB 兜底补背景图，配置在 `manage/data/tmdb.json`（gitignored：`{"api_key", "proxy"}`，env `TMDB_API_KEY`/`TMDB_PROXY` 优先；TMDB 图床国内被墙，图片经 `/api/img` 服务端代理转发；批量补图 `POST /api/catalog/backfill`）
- **cine.py** — CINE 用户体系（pbkdf2 + HttpOnly Cookie 会话）、收藏/观看历史、`/api/resource/search` 设备多站点并发聚合搜索（片名归一化匹配打分）、`/api/resource/adopt` 资源影片注册、`/api/resource/scan` 智能选源（POST 启动 + SSE 流式回传）、`/api/img` 图片防盗链透传、直播页全链路（`/api/live/list|play|epg` 设备桥直连优先、`liveprobe.py` 线路体检、频道收藏 `live_favorites` / 观看历史 `live_history` 每用户 10 条、直播源登记 `live_sources`——`/api/live/list` 自动登记全部 lives 并过滤已禁用源，默认源被禁用时自动切第一个可用源；管理后台 `GET/POST /api/live-sources[/set]` 可禁用，禁用后 /cine 源选择器不展示）
- **probe.py** — 智能选源探测引擎：对「站点×线路」候选逐个探测三个维度——速度（playerContent 解析耗时 + m3u8 首字节 + 首分片吞吐合成首帧估计）、清晰度（master playlist RESOLUTION 优先，否则首分片 ffprobe 读宽高，未装 ffprobe 降级未知）、广告（前置贴片启发式：前部 EXT-X-DISCONTINUITY / 首段时长异常 / 首段异域 / 重定向广告域，≥2 信号判 dirty、1 个判 suspect，只标记不剥离）；另产出正片总时长 durationS（m3u8 分片 EXTINF 求和）；取流复用 /stream 同路径（httpx 直连 / 经设备 fetch）；并发受控（详情 3 / 探测 4 / 每站线路上限 8）且设备掉线时等桥接重连再重试，长时间离线则中止扫描防刷屏；结果缓存 `probe_cache`（6h TTL，失败不缓存），滚动写 `site_stats`（站点历史广告率作排序先验）
- **templates/index.html** — Single-page management dashboard (dark theme, hls.js for video playback)
- Data stored in `manage/data/urls.db` (gitignored)

### CINE 视频站（web/ + /cine）

基于 cine 模板（React 19 + Vite + Tailwind 4，UI 不变）的完整视频站，模板 localStorage 假数据全部换成后端 API：
- 首页/片库数据来自豆瓣缓存（`/api/catalog/all|detail|search`），登录后收藏与历史落库（`/api/user/*`），登录注册为真实账号（`/api/auth/*`）
- 播放链路：点影片 → `/api/resource/search` 经设备桥并发搜多站点 → 匹配打分选源 → `/api/detail` 拿线路/选集 → `/api/player` 拿播放地址 → hls.js 播 `/stream` 代理流
- 智能选源：进播放页/详情页自动 `POST /api/resource/scan`（候选=命中站点×线路×第 1 集，站点去重上限 15、每站线路上限 8）→ SSE 渐进收结果 → 线路/站点徽章（速度/清晰度/广告）；扫描完成自动切到推荐源（当前源失败/有广告或推荐源综合分领先 >0.15 才切，保留进度与集数），用户手动换源后本影片不再自动切；`selectMatch`/`selectFlag` 的 `manual` 参数为 false 时表示程序自动切换（不标记 userPicked）；`web/src/utils/scanFormat.ts` 徽章文案共用
- 详情页站点分组：详情页不再展示选源/选集（只有资源状态提示行），站点五组分类（推荐/有广告/时长异常/网盘/探测失败）改由播放页的选源弹窗展示——分类逻辑在 `web/src/utils/siteGroups.ts` 的 `classifySites`（时长异常=中位数 0.45~2.2 倍偏离+电影 <40min 绝对下限；网盘=扫码登录或夸父等特征），弹窗组件 `web/src/components/SourcePickerModal.tsx`（扫描中渐进展示部分结果）
- 播放页布局：播放器下方是「当前线路按钮（站点·线路+三维度徽章，点击开选源弹窗）+ 扫描进度 + 当前线路选集按钮网格」；侧栏仅保留猜你喜欢；换源经 `applySource(siteKey, flag?, manual?)`（同站切 flag / 跨站重拉详情后切，携带播放位置，集数按 number 延续）
- subjects 表是统一影片注册表（豆瓣种子 + 资源反填），收藏/历史按 subject_id 关联；安卓端零改动

## Key Dependencies

- Player: Media3 1.10.0 + FFmpeg
- Image: Glide 5
- Network: OkHttp 5.3.2
- DLNA: jUPnP
- DB: Room
- Backend: FastAPI, uvicorn, httpx, Jinja2

## Key Conventions

- Product flavors use two dimensions: `mode` (leanback/mobile) × `abi` (arm64_v8a/armeabi_v7a)
- Java 17, compileSdk 37, minSdk 24, targetSdk 28
- Version constants (Gson, Glide, OkHttp, Media3) are defined in root `build.gradle` as `project.ext`
- Local `.aar` libraries live in `app/libs/` (flatDir repo)
- ProGuard rules split between `app/proguard-rules.pro` and `app/proguard-rules-media.pro`
- The app embeds a NanoHTTPD server on ports 9978–9998 for remote control
