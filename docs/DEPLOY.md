# 服务端部署指南（manage + CINE）

生产环境拓扑：**App/浏览器 → nginx(443) → uvicorn(127.0.0.1:8000，单 worker)**。nginx 挂 `/tv-manage` 前缀反代后端，`/apk/` 提供安装包静态下载。

## 一、准备

### 服务器要求

| 项目 | 要求 | 用途 |
|------|------|------|
| 系统 | Linux（Ubuntu 22.04 / Debian 12） | |
| 配置 | 1C2G 起步；带宽优先 | 爬虫跑在设备端，服务器主要做流代理，`/stream` 带宽 = 码率 × 并发 |
| Python | **3.10+**（本机开发 3.12） | 代码用了 `int \| None` 语法 |
| ffmpeg/ffprobe | 必须 | 智能选源清晰度探测、AC3→AAC 音频转码、下载器 |
| Node.js 20+ | 可选 | 服务器上构建前端；也可本机构建后只传产物 |
| nginx | 必须 | 反代 + HTTPS + APK 静态目录 |

### 需要迁移的文件（gitignore，不在仓库里）

```
manage/data/            # 整个目录：urls.db(VOD/直播源) cine.db(用户/收藏/历史)
                        # probe_cache.db site_stats tmdb.json download-admin.key ...
manage/static/cine/     # 前端构建产物（或服务器重新 build）
app/build/outputs/apk/  # 如需 /apk/ 下载页
```

**先停本机服务再拷 data/**，SQLite 热拷贝可能不一致。

### 环境变量（生产建议）

所有变量都有合理默认值，不设也能跑。常见需要设置的只有 TMDB 两项（见下节）和小磁盘场景的 DOWNLOAD 配额。

| 变量 | 说明 | 默认 |
|------|------|------|
| `TMDB_API_KEY` | 豆瓣图床兜底用的 TMDB API Key（详见下节） | 空 |
| `TMDB_PROXY` | 服务器访问 TMDB 的代理地址（国内服务器需要） | 空 |
| `BRIDGE_TOKEN` | App↔服务器 WebSocket 鉴权 token。**注意：当前 App 未适配 token 透传，设置了会导致桥接连不上（4001），现阶段保持不设**，仅当自建客户端能拼 `?token=` 时使用 | 空（不校验） |
| `DOWNLOAD_DIR` | 下载器存储目录 | `data/downloads` |
| `DOWNLOAD_MAX_BYTES` | 单个下载任务体积上限 | 20 GiB |
| `DOWNLOAD_MIN_FREE_BYTES` | 磁盘剩余低于此值拒新任务 | 1 GiB |
| `DOWNLOAD_MAX_STORAGE_BYTES` | 下载目录总占用上限 | 100 GiB |
| `DOWNLOAD_RETENTION_HOURS` | 下载文件保留时长，过期自动清理 | 24 小时 |
| `DOWNLOAD_CONCURRENCY` | 同时下载任务数 | 2 |
| `DOWNLOAD_ALLOWED_HOSTS` | 公网清单模式下允许设备取流的目标 host 白名单（逗号分隔） | 空（不限制） |
| `FFMPEG` / `FFPROBE` | 可执行文件路径覆盖（默认 PATH 里找，装了系统包不用设） | 自动探测 |

### TMDB 图床兜底配置（已配置，迁移时投照搬）

豆瓣图片缺失时用 TMDB 补背景图/海报；不配则部分影片无图，不影响功能。
本机已有可用配置，两种方式二选一（环境变量优先于文件）：

```bash
# 方式一：配置文件（推荐，和本机一致，直接拷贝）
# 迁移时把本机 manage/data/tmdb.json 原样拷到服务器同路径即可，格式：
cat > /opt/TV/manage/data/tmdb.json << 'EOF'
{
  "api_key": "换成你的key（见下方获取方式）",
  "proxy": "http://127.0.0.1:7897"
}
EOF

# 方式二：systemd 环境变量（编辑 /etc/systemd/system/tv-manage.service 的 [Service] 段）
Environment=TMDB_API_KEY=换成你的key
Environment=TMDB_PROXY=http://127.0.0.1:7897
```

**获取 API Key**：注册 https://www.themoviedb.org → 设置 → API → 申请
Developer API → 得到 API Key (v3)。

**注意事项**：
- ⚠️ key 不要写进任何入库文件（本仓库公开，历史提交里的 key 视为已泄露），
  只放服务器/本机的 `manage/data/tmdb.json`（已 gitignore）或 systemd 环境变量。
  若 key 已在公开场合泄露：去 TMDB 删除旧 key 重新生成，再更新本地 tmdb.json
- `127.0.0.1:7897` 是本机代理端口；**服务器上需自己跑一个代理**（端口自定，
  改成服务器上实际的代理地址），或换成服务器可达的代理地址
- TMDB 图床国内被墙：服务器在国内时代理必填，否则补图永远失败
  （仅影响缺图影片，有 12h 定时刷新，不用急）
- 配好后可 `POST /api/catalog/backfill` 批量补历史缺图

## 二、部署步骤

### 1. 装系统依赖

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg nginx git
```

### 2. 同步代码与数据

```bash
# 方式一：git（推荐）
git clone <你的仓库> /opt/TV && cd /opt/TV/manage

# 方式二：rsync 整仓（含 gitignored 数据，本机先停服务）
rsync -av --exclude '.venv' --exclude 'node_modules' \
  ./manage/ user@server:/opt/TV/manage/
```

### 3. Python 环境

```bash
cd /opt/TV/manage
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# 冒烟验证
.venv/bin/python -c "import app; print('ok')"
```

### 4. 前端（可选在服务器构建）

```bash
cd /opt/TV/web && npm install && npm run build   # 产物自动输出到 manage/static/cine
```

### 5. systemd 常驻服务

`/etc/systemd/system/tv-manage.service`：

```ini
[Unit]
Description=TV manage backend
After=network.target

[Service]
WorkingDirectory=/opt/TV/manage
# Environment=TMDB_API_KEY=...   # 需要时逐个加
ExecStart=/opt/TV/manage/.venv/bin/python -m uvicorn app:app \
    --host 127.0.0.1 --port 8000 \
    --root-path /tv-manage \
    --ws-ping-interval 20 --ws-ping-timeout 60
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> ⚠️ **绝对不要加 `--workers`**：设备桥、扫描缓存、下载锁都要求单 worker（`downloads.py` 会直接报错拒绝启动）。
> ⚠️ `--ws-ping-timeout 60` 必须：智能选源时设备爬虫高负载会拖慢心跳，uvicorn 默认 20s 会掐断桥接。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tv-manage
```

### 6. nginx 站点配置

`/etc/nginx/sites-available/tv-manage`：

```nginx
server {
    listen 80;
    server_name your.domain.com;          # 换成域名或 IP

    client_max_body_size 20m;

    # APK 静态下载
    location /apk/ {
        alias /var/www/tv-apk/;
        autoindex off;
    }

    # 后端反代（/tv-manage 前缀在这里剥掉，uvicorn --root-path 补偿感知）
    location /tv-manage/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;

        # WebSocket（App 桥接 /ws、扫描 SSE）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE 与视频流代理不能缓冲（/api/resource/* /stream /ws）
        proxy_buffering off;
        proxy_cache off;

        # 长连接超时：≥ ws-ping-timeout(60s)，扫描/播放会话保持
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tv-manage /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7. HTTPS（强烈建议，App 桥接要用 wss）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

### 8. 防火墙

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
# 8000 只绑 127.0.0.1，不对外
```

### 9. APK 上架

```bash
sudo mkdir -p /var/www/tv-apk
sudo cp app/build/outputs/apk/leanbackArm64_v8a/release/leanback-arm64_v8a.apk /var/www/tv-apk/
sudo cp app/build/outputs/apk/mobileArm64_v8a/release/mobile-arm64_v8a.apk /var/www/tv-apk/
```

## 三、客户端接入

| 端 | 地址 |
|----|------|
| App（设置页「管理地址」） | `https://your.domain.com/tv-manage`（设了 BRIDGE_TOKEN 则加 `?token=xxx`） |
| CINE 网页 | `https://your.domain.com/tv-manage/cine/` |
| 管理后台 | `https://your.domain.com/tv-manage/` |

App 桥接会自动把管理地址转成 `wss://…/tv-manage/ws`；管理端改配置会经桥接推送动态生效。

## 四、日常运维

### 升级版本

```bash
cd /opt/TV && git pull
cd manage && .venv/bin/pip install -r requirements.txt   # 依赖有变时
cd ../web && npm install && npm run build                # 前端有变时
sudo systemctl restart tv-manage
```

App 端有更新时重新构建 APK 并覆盖 `/var/www/tv-apk/`，用户侧手动更新或走 App 内检查更新。

### 数据备份（SQLite）

核心库在 `manage/data/`：`urls.db`（源配置）、`cine.db`（用户/收藏/历史）、`probe_cache.db`（选源缓存）。
备份前用 sqlite3 的 `.backup` 保证一致性（比直接 cp 安全，可热备）：

```bash
# 手动备份
sqlite3 /opt/TV/manage/data/urls.db ".backup '/backup/urls-$(date +%F).db'"

# cron 每日 4 点备份（crontab -e）
0 4 * * * sqlite3 /opt/TV/manage/data/urls.db ".backup '/backup/urls-$(date +\%F).db'" && sqlite3 /opt/TV/manage/data/cine.db ".backup '/backup/cine-$(date +\%F).db'"
```

### 日志查看

```bash
journalctl -u tv-manage -f          # 实时（桥接设备上/下线、请求日志都在这）
journalctl -u tv-manage --since today | grep -a "device connected"
```

### 数据库迁移注意

代码升级后首次启动会自动建新表/补列（init_db），无需手工迁移；跨大版本回退前先备份 data/。

## 五、验证清单

```bash
# 1. 服务健康
systemctl status tv-manage
curl -s http://127.0.0.1:8000/api/device          # 应返回 JSON

# 2. 经 nginx 全链路
curl -s https://your.domain.com/tv-manage/api/device
curl -sI https://your.domain.com/tv-manage/cine/  # 200

# 3. App 打开 → 管理后台能看到设备在线；改一个 VOD 源开关，App 站点数秒内变化（动态推送）

# 4. CINE 播放一集（验证 /stream 代理与 SSE 扫描）
```

## 六、常见坑

- **8000 直接对公网开放**：绕过 nginx 的 root-path，App 会连不上且无 HTTPS
- **`--workers 2`**：启动即报「缓存任务和设备桥只支持单个 Uvicorn worker」
- **nginx 开了缓冲**：SSE 扫描进度不出、播放卡首帧——`proxy_buffering off` 必须保留
- **SQLite 热迁移**：本机服务没停就 rsync data/，数据库可能损坏
- **服务器没有 ffmpeg**：智能选源清晰度降级未知、AC3 音源无声、下载器不可用
- **国内服务器配 TMDB 不加代理**：补图永远失败（仅影响缺图影片，有 12h 定时刷新，不用急）
- **首台连上的设备自动成为搜索来源**：多台设备时在管理后台「设备」页手动选定
- **服务重启后设备要等一会才上线**：App 桥接断线重连退避最长 60s，属正常现象
