# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TV is an open-source Android media streaming app (package `com.fongmi.android.tv`) based on the CatVod spider framework. It produces two APK variants — **leanback** (Android TV/D-pad) and **mobile** (phone/touch) — from a shared codebase. A companion web app (`tv-web/`) provides a browser-based frontend with a Node.js backend.

## Build Commands

### Android (Gradle)

```bash
# Build all release APKs (outputs to Release/apk/ and app/build/outputs/apk/)
# IMPORTANT: Must use --no-daemon -Dorg.gradle.jvmargs="-Xmx2g -XX:+UseParallelGC" to limit heap to 2G
./gradlew assembleRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx2g -XX:+UseParallelGC"

# Build a specific variant
./gradlew assembleMobileArm64_v8aRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx2g -XX:+UseParallelGC"
./gradlew assembleLeanbackArm64_v8aRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx2g -XX:+UseParallelGC"

# Clean
./gradlew clean
```

Release APKs are named `{mode}-{abi}.apk` (e.g., `leanback-arm64_v8a.apk`). Signing config comes from `local.properties` (gitignored): set `storeFile`, `keyAlias`, `keyPassword`, `storePassword`.

No lint or test commands are configured — the project has no test suite.

### tv-web (Node.js)

```bash
cd tv-web
npm install            # install all workspace dependencies
npm run dev            # run server + web dev servers concurrently
npm run build          # build web frontend (vite build)
```

The Vite dev server proxies `/api` requests to `localhost:3000` (Express server).

## Architecture

### Gradle Modules (settings.gradle)

| Module | Purpose |
|--------|---------|
| `app` | Main Android application — UI, player, DB, server |
| `catvod` | Spider interface + OkHttp networking (used by all spider types) |
| `quickjs` | QuickJS JavaScript engine wrapper for JS spiders |
| `chaquo` | Chaquopy Python runtime for Python spiders |

### Android Source Sets

- **`app/src/main/`** — Shared business logic: API layer (`api/`), data models (`bean/`), Room DB (`db/`), ExoPlayer/Media3 playback (`player/`), NanoHTTPD local server (`server/`), utilities
- **`app/src/leanback/`** — Android TV UI: Leanback fragments/presenters, DLNA DMR (renderer), boot receiver
- **`app/src/mobile/`** — Phone UI: touch fragments, DLNA DMC (caster), ZXing QR scanner

The two UI flavors share all logic in `main/` but have completely separate UI layers. Leanback uses `androidx.leanback` Presenter patterns; mobile uses standard touch-based fragments.

### Spider System

The app loads external crawlers (spiders) at runtime through a unified `Spider` interface defined in `catvod/`. Three runtime engines are supported:

- **Java JARs** — loaded via DexClassLoader
- **JavaScript** — executed in QuickJS sandbox
- **Python** — executed via Chaquopy

Spider lifecycle: `init` → `homeContent` → `homeVideoContent` → `categoryContent` → `detailContent` → `searchContent` → `playerContent` → `destroy`. See `docs/SPIDER.md` for the full API spec.

### Configuration

VOD and Live TV are configured via external JSON files. See `docs/CONFIG.md` for the full schema. Key config fields: `sites` (spider sources), `parses` (extractors), `lives` (live TV sources), `doh`, `proxy`, `rules`.

### tv-web

npm workspace monorepo with two packages:

- **`tv-web/server/`** — Express 5 backend (ESM), serves spider/live/proxy API routes
- **`tv-web/web/`** — Vue 3 + Vite + Naive UI + HLS.js frontend

### Key Dependencies

- Player: Media3 1.10.0 + FFmpeg
- Image: Glide 5
- Network: OkHttp 5.3.2
- DLNA: jUPnP
- DB: Room
- Web: Express 5, Vue 3, Pinia, Naive UI, HLS.js

## Key Conventions

- Product flavors use two dimensions: `mode` (leanback/mobile) × `abi` (arm64_v8a/armeabi_v7a)
- Java 17, compileSdk 37, minSdk 24, targetSdk 28
- Version constants (Gson, Glide, OkHttp, Media3) are defined in root `build.gradle` as `project.ext`
- Local `.aar` libraries live in `app/libs/` (flatDir repo)
- ProGuard rules split between `app/proguard-rules.pro` and `app/proguard-rules-media.pro`
- The app embeds a NanoHTTPD server on ports 9978–9998 for remote control
