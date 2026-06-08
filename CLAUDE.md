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
uvicorn app:app --host 0.0.0.0 --port 8000 --root-path /tv-manage
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
- **database.py** — SQLite layer with tables: `urls`, `app_versions`, `home_contents`, `videos`
- **templates/index.html** — Single-page management dashboard (dark theme, hls.js for video playback)
- Data stored in `manage/data/urls.db` (gitignored)

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
