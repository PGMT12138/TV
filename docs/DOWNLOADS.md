# CINE 下载与缓存

播放页的“下载”按钮现在可以创建完整视频缓存任务。服务端准备好文件后，用户点击“保存到本机”，浏览器下载原始视频文件。管理端首页的“下载与缓存管理”入口打开 `/downloads`，前缀部署时对应 `/tv-manage/downloads`。

## 使用方式

- 网站用户登录后，可缓存当前电影或当前集。创建时固定影片、站点、线路、选集和来源设备；播放器换集或换源不影响任务。
- 下载面板显示服务器排队、解析、下载、封装和校验进度，可取消、从头重试及删除服务端文件。
- 页面关闭后后台任务继续，重新打开播放页的下载面板可查询自己的全部记录。
- 浏览器保存到本机的进度由浏览器下载管理器显示。管理页面可下载文件，也可预览浏览器支持的编码。
- 管理员可查看所有用户的记录，按状态筛选、分页，管理任务及已保存文件。删除文件后保留记录；已下载到用户本机的文件不会被删除。

## 缓存总开关

管理页面的开关持久化在 SQLite `settings.downloads_enabled`，默认开启。

关闭时，停止所有排队和正在执行的任务，禁止网站新建和重试，管理员重试也被拒绝。此限制在后端执行，不能通过直接调用 API 绕过。已完成文件保留，仍可查看、下载和删除；到期清理正常进行。重新开启后，已停止任务需要手动重试，不会自动重启。

网站会定期更新开关显示，打开的下载面板约每 2 秒更新；后端限制立即生效。

## 部署

运行环境为 Python 3.11+，安装 `manage/requirements.txt`，额外需要系统可执行文件 `ffmpeg` 和 `ffprobe`。Windows 可通过环境变量指定完整路径，子进程以隐藏窗口运行。

```powershell
# 仓库根目录，复用项目虚拟环境
& manage/.venv/Scripts/python.exe -m pip install -r manage/requirements.txt
cd web
npm ci
npm run build
cd ../manage
& .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8100 --ws-ping-interval 20 --ws-ping-timeout 60
```

Linux 部署同样安装 Python 依赖及 FFmpeg，使用现有服务启动方式；经 `/tv-manage/` 反向代理时保留 `--root-path /tv-manage`。下载文件 API 需要允许 GET、HEAD 和 Range，不要为这些接口开启公共缓存。`manage/nginx.conf` 为现有部署参考。

任务调度与设备 WebSocket 共用进程，必须使用单个 Uvicorn worker。缓存目录中的进程锁会拒绝第二个 worker，防止任务被重复执行。

### 管理页面访问

缓存管理与现有管理端一致，直接打开即可查看和管理所有用户的任务及文件，不需要管理访问密钥或单独登录。已移除密钥生成、管理会话和登录/退出接口。

视频网站的用户接口仍要求登录并检查任务归属，管理端写接口保留跨站请求校验。

### 配置项

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DOWNLOAD_DIR` | `manage/data/downloads` | 受管缓存目录，不能暴露为公共静态目录 |
| `DOWNLOAD_CONCURRENCY` | 2 | 全局同时执行任务数，每个用户同时最多 1 个 |
| `DOWNLOAD_MAX_BYTES` | 21474836480 | 单任务最多 20 GiB |
| `DOWNLOAD_MAX_STORAGE_BYTES` | 107374182400 | 缓存目录最多约 100 GiB，包含处理中间文件 |
| `DOWNLOAD_MIN_FREE_BYTES` | 1073741824 | 保留至少约 1 GiB 磁盘空闲空间 |
| `DOWNLOAD_RETENTION_HOURS` | 24 | 完成文件保留小时数，每分钟检查到期 |
| `FFMPEG`、`FFPROBE` | 从 PATH 查找 | 可执行文件路径 |
| `DOWNLOAD_ALLOWED_HOSTS` | 空 | 逗号分隔的可信内网源域名/IP例外，仅按实际需要配置 |

每用户最多排队及执行 10 个任务，全局最多 100 个；每任务最长 6 小时。临时文件和 SQLite位于已忽略的 `manage/data` 下。部署者应确保磁盘空间和目录写权限；受管目录只用于本功能生成的文件。

## 媒体范围与实现

- MP4、MKV、TS 整文件以原始字节保存，识别后使用对应文件扩展名。不会将整部电影载入内存。
- HLS 按响应内容识别，支持无后缀入口、重定向、主清单、最高带宽变体、默认独立音轨、TS、fMP4 初始化片段、字节范围和标准 AES-128 密钥。
- 清单和媒体通过专用原始取流器获取，不走网页播放的音频兼容转码。清单中的实际媒体资源全部下载成功后，生成只引用受管目录本地文件的清单，由 FFmpeg 流复制封装，优先 MP4，不兼容时回退 MKV。
- 使用 ffprobe 校验视频轨道和时长。分片缺失最多请求 3 次，仍失败则任务失败并清理文件，不发布残缺结果。
- 不支持直播、未结束的 HLS 清单、DRM、整季批量、跨重启分片续传及重新编码。失败重试从头开始；生成文件在浏览器中的播放兼容性取决于原始编码。
- 当前版本仅在首次 player 返回无效 URL 时按原线路和选集序号刷新 token；下载过程中令牌失效会有限重试后报错，可手动从头重试重新解析。

### Android 设备代理

公网源解析后可由服务器直接下载；需要设备本地代理的来源，下载全程要求对应设备在线。任务不会跟随管理端当前设备切换。

本次更新 `Bridge.java`：hello 声明 `fetchFlow` 能力，下载 fetch 使用 8 帧消费确认窗口，新增 `fetchAck` / `cancelFetch`，断开时取消取流。缓存请求的公网 DNS 固定到服务端校验后的 IP，重定向由服务端逐跳校验；正常网页播放 fetch 保持原方式。

**设备代理缓存需要安装包含本次 Bridge.java 的新版 App。** 旧版设备仍可解析公网源，依赖设备代理的缓存会提示升级，避免旧设备持续发送未受控数据。

## API

网站接口需要 CINE 用户会话，配置查询除外，并检查文件与任务归属。管理接口直接访问，可管理所有用户任务。写接口拒绝跨站请求。

| 方法与路径 | 用途 |
|---|---|
| GET `/api/downloads/config` | 开关、工具可用性、保留时长 |
| POST `/api/downloads` | 创建任务；同用户、同设备、同来源的进行中任务去重 |
| GET `/api/downloads?offset=0` | 自己的记录，每页 100 条 |
| GET `/api/downloads/{id}` | 任务状态 |
| POST `/api/downloads/{id}/cancel` | 取消任务 |
| POST `/api/downloads/{id}/retry` | 从头重试 |
| DELETE `/api/downloads/{id}` | 删除服务端文件，保留记录 |
| GET / HEAD `/api/downloads/{id}/file` | 文件下载，支持 Range；`preview=true` 返回 inline |
| GET `/api/admin/downloads?status=&offset=0` | 全用户记录、文件占用、开关信息 |
| PUT `/api/admin/downloads/settings` | `{"enabled": false}` 关闭缓存 |
| POST `/api/admin/downloads/{id}/cancel`、`/retry` | 管理所有用户任务 |
| DELETE `/api/admin/downloads/{id}` | 删除任意用户服务端文件 |
| GET / HEAD `/api/admin/downloads/{id}/file` | 下载 / 预览任意已完成文件 |

文件正被响应传输时删除会返回 409，避免传输中途截断。刷新后的缺失文件会标为 `missing`；过期文件标为 `expired`。服务重启将未完成任务标为 `interrupted`，保留可重试记录。

## 验收

```powershell
cd manage
& .venv/Scripts/python.exe -m unittest discover -p 'test_*.py'
cd ../web
npm run lint
npm run build
npm run test:downloads
npm run test:selection
npm run test:media
```

浏览器测试需要 Playwright 与对应 Chromium；可设置 `PLAYWRIGHT_MODULE`、`CINE_PYTHON`、`CINE_UI_SCREENSHOT_DIR`。`test:downloads` 启动隔离的 SQLite、FastAPI 和本地媒体服务器，使用真实 FFmpeg 生成 HLS，并在 `/tv-manage` 前缀下测试网站保存、管理员预览/下载、开关限制、取消重试和删除保留记录。它不访问实际影视站点，也不使用真实用户数据库。

自动化验收包含 320px 和 1280px 页面布局检查。Android 设备桥接进行了 Java 编译检查；真实 Android 设备与外部站点的完整下载仍需要在部署并更新 App 后按上述流程实测。

### 本次验收结果（2026-09-07）

| 检查 | 结果 |
|---|---|
| Python 后端全量回归 | 73 / 73 通过，其中缓存相关 28 项 |
| 播放页浏览器回归 | 原有 49 项及新增下载来源固定、开关限制 2 项通过 |
| 扫描生命周期浏览器回归 | 6 / 6 通过 |
| 真实 HLS 播放与故障恢复 | 13 / 13 通过 |
| 下载与管理端真实浏览器端到端 | 10 / 10 通过 |
| TypeScript 检查及 Vite 生产构建 | 通过 |
| Android `compileMobileArm64_v8aDebugJavaWithJavac` | 通过；编译器报告现有依赖注解警告 |

验收使用本地生成的视频与隔离数据库，未发布到线上，未在真实 Android 设备或第三方影视站点进行下载实测。页面截图保存在本地 `manage/data/download-acceptance/`，不纳入 Git。
