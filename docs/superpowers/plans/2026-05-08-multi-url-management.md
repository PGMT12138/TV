# Multi-URL Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python management service for configuring multiple VOD/Live URLs, and modify the Android app to fetch and merge configs from those URLs into a unified source list.

**Architecture:** Separate Python FastAPI service with SQLite storage and a web management page. The Android app adds a "manage address" config (type=3) in settings. On load, the app fetches the URL list from the management API, requests each config URL, and merges all sites/lives into one list. Falls back to single-URL mode if management address is not configured.

**Tech Stack:** Python 3 (FastAPI, SQLite3, Jinja2, uvicorn), Android Java (Room, OkHttp, Gson)

---

## File Structure

### New Files (Python Management Service)

| File | Purpose |
|------|---------|
| `manage/app.py` | FastAPI application, routes, API endpoints |
| `manage/database.py` | SQLite database initialization and CRUD operations |
| `manage/templates/index.html` | Single-page management UI with VOD/Live tabs |
| `manage/requirements.txt` | Python dependencies |

### Modified Files (Android App)

| File | Change |
|------|--------|
| `app/src/main/java/com/fongmi/android/tv/api/config/BaseConfig.java` | Add `MANAGE = 3` constant |
| `app/src/main/java/com/fongmi/android/tv/bean/Config.java` | Add `Config.manage()` static method |
| `app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` | Add multi-URL load + merge logic |
| `app/src/main/java/com/fongmi/android/tv/api/config/LiveConfig.java` | Add multi-URL load + merge logic |
| `app/src/main/res/values/strings.xml` | Add "Manage" string resource |
| `app/src/main/res/values-zh-rCN/strings.xml` | Add "管理地址" string resource |
| `app/src/main/res/values-zh-rTW/strings.xml` | Add "管理地址" string resource |
| `app/src/leanback/res/layout/activity_setting.xml` | Add manage row UI |
| `app/src/mobile/res/layout/fragment_setting.xml` | Add manage row UI |
| `app/src/leanback/java/.../ui/activity/SettingActivity.java` | Add manage input handler |
| `app/src/mobile/java/.../ui/fragment/SettingFragment.java` | Add manage input handler |

---

## Task 1: Python Management Service — Database Layer

**Files:**
- Create: `manage/database.py`

- [ ] **Step 1: Create the database module**

```python
# manage/database.py
import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "urls.db")


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type INTEGER NOT NULL,
            name TEXT DEFAULT '',
            url TEXT NOT NULL,
            sort INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at TEXT DEFAULT ''
        )
    """)
    conn.commit()
    conn.close()


def get_urls(url_type: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, url, sort, enabled FROM urls WHERE type = ? AND enabled = 1 ORDER BY sort ASC, id ASC",
        (url_type,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_urls(url_type: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, url, sort, enabled, created_at FROM urls WHERE type = ? ORDER BY sort ASC, id ASC",
        (url_type,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_url(url_type: int, name: str, url: str, sort: int = 0) -> dict:
    conn = get_conn()
    now = datetime.now().isoformat()
    cursor = conn.execute(
        "INSERT INTO urls (type, name, url, sort, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        (url_type, name, url, sort, now),
    )
    row_id = cursor.lastrowid
    conn.commit()
    row = conn.execute("SELECT id, name, url, sort, enabled, created_at FROM urls WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_url(row_id: int, name: str = None, url: str = None, sort: int = None, enabled: bool = None) -> dict:
    conn = get_conn()
    sets = []
    params = []
    if name is not None:
        sets.append("name = ?")
        params.append(name)
    if url is not None:
        sets.append("url = ?")
        params.append(url)
    if sort is not None:
        sets.append("sort = ?")
        params.append(sort)
    if enabled is not None:
        sets.append("enabled = ?")
        params.append(1 if enabled else 0)
    if not sets:
        conn.close()
        raise ValueError("No fields to update")
    params.append(row_id)
    conn.execute(f"UPDATE urls SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT id, name, url, sort, enabled, created_at FROM urls WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    return dict(row)


def delete_url(row_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM urls WHERE id = ?", (row_id,))
    conn.commit()
    conn.close()
```

- [ ] **Step 2: Verify the database module works**

Run: `cd /home/projects/TV/manage && python3 -c "from database import init_db, add_url, get_urls; init_db(); add_url(0, 'Test', 'https://example.com/config.json'); print(get_urls(0))"`
Expected: `[{'id': 1, 'name': 'Test', 'url': 'https://example.com/config.json', 'sort': 0, 'enabled': 1}]`

- [ ] **Step 3: Commit**

```bash
git add manage/database.py
git commit -m "feat(manage): add SQLite database layer for URL management"
```

---

## Task 2: Python Management Service — FastAPI App

**Files:**
- Create: `manage/app.py`
- Create: `manage/requirements.txt`

- [ ] **Step 1: Create requirements.txt**

```
# manage/requirements.txt
fastapi>=0.115.0
uvicorn>=0.34.0
jinja2>=3.1.0
```

- [ ] **Step 2: Create the FastAPI application**

```python
# manage/app.py
import os
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from database import init_db, get_urls, get_all_urls, add_url, update_url, delete_url

app = FastAPI()
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

init_db()


class UrlCreate(BaseModel):
    type: int
    name: str = ""
    url: str
    sort: int = 0


class UrlUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    sort: int | None = None
    enabled: bool | None = None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/urls")
async def list_urls(type: int):
    return {"urls": get_urls(type)}


@app.get("/api/urls/all")
async def list_all_urls(type: int):
    return {"urls": get_all_urls(type)}


@app.post("/api/urls")
async def create_url(item: UrlCreate):
    return add_url(item.type, item.name, item.url, item.sort)


@app.put("/api/urls/{url_id}")
async def modify_url(url_id: int, item: UrlUpdate):
    return update_url(url_id, item.name, item.url, item.sort, item.enabled)


@app.delete("/api/urls/{url_id}")
async def remove_url(url_id: int):
    delete_url(url_id)
    return {"ok": True}
```

- [ ] **Step 3: Install dependencies and verify the app starts**

Run: `cd /home/projects/TV/manage && pip install -r requirements.txt && timeout 3 python3 -m uvicorn app:app --host 127.0.0.1 --port 18080 || true`
Expected: Server starts without errors (will timeout after 3s, that's fine)

- [ ] **Step 4: Commit**

```bash
git add manage/app.py manage/requirements.txt
git commit -m "feat(manage): add FastAPI application with URL CRUD endpoints"
```

---

## Task 3: Python Management Service — Web UI

**Files:**
- Create: `manage/templates/index.html`

- [ ] **Step 1: Create the management page template**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TV Config Management</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { text-align: center; margin: 20px 0 30px; font-size: 24px; color: #e94560; }
        .tabs { display: flex; gap: 0; margin-bottom: 20px; }
        .tab { flex: 1; padding: 12px; text-align: center; cursor: pointer; background: #16213e; border: 1px solid #0f3460; color: #aaa; font-size: 16px; transition: all 0.2s; }
        .tab:first-child { border-radius: 8px 0 0 8px; }
        .tab:last-child { border-radius: 0 8px 8px 0; }
        .tab.active { background: #0f3460; color: #fff; }
        .add-bar { display: flex; gap: 8px; margin-bottom: 16px; }
        .add-bar input { flex: 1; padding: 10px 12px; border: 1px solid #0f3460; border-radius: 6px; background: #16213e; color: #eee; font-size: 14px; }
        .add-bar input::placeholder { color: #666; }
        .add-bar input:focus { outline: none; border-color: #e94560; }
        .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; transition: opacity 0.2s; }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background: #e94560; color: #fff; }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        .btn-edit { background: #0f3460; color: #fff; }
        .btn-delete { background: #533483; color: #fff; }
        .btn-toggle { background: #1a1a2e; color: #aaa; border: 1px solid #333; }
        .btn-toggle.active { background: #0f3460; color: #fff; border-color: #0f3460; }
        .url-list { list-style: none; }
        .url-item { display: flex; align-items: center; gap: 10px; padding: 12px; background: #16213e; border: 1px solid #0f3460; border-radius: 8px; margin-bottom: 8px; }
        .url-item.disabled { opacity: 0.5; }
        .url-info { flex: 1; min-width: 0; }
        .url-name { font-weight: 600; font-size: 14px; color: #e94560; }
        .url-addr { font-size: 13px; color: #888; word-break: break-all; margin-top: 2px; }
        .url-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .empty { text-align: center; color: #666; padding: 40px; font-size: 14px; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 100; justify-content: center; align-items: center; }
        .modal-overlay.show { display: flex; }
        .modal { background: #1a1a2e; border: 1px solid #0f3460; border-radius: 12px; padding: 24px; width: 90%; max-width: 500px; }
        .modal h3 { margin-bottom: 16px; color: #e94560; }
        .modal label { display: block; margin-bottom: 4px; font-size: 13px; color: #aaa; }
        .modal input { width: 100%; padding: 10px; margin-bottom: 12px; border: 1px solid #0f3460; border-radius: 6px; background: #16213e; color: #eee; font-size: 14px; }
        .modal input:focus { outline: none; border-color: #e94560; }
        .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .btn-cancel { background: #333; color: #aaa; }
    </style>
</head>
<body>
    <div class="container">
        <h1>TV Config Management</h1>
        <div class="tabs">
            <div class="tab active" data-type="0" onclick="switchTab(0)">VOD</div>
            <div class="tab" data-type="1" onclick="switchTab(1)">Live</div>
        </div>
        <div class="add-bar">
            <input type="text" id="inputName" placeholder="Name (optional)">
            <input type="text" id="inputUrl" placeholder="Config URL">
            <button class="btn btn-primary" onclick="addUrl()">Add</button>
        </div>
        <ul class="url-list" id="urlList"></ul>
        <div class="empty" id="empty" style="display:none">No URLs configured</div>
    </div>

    <div class="modal-overlay" id="editModal">
        <div class="modal">
            <h3>Edit URL</h3>
            <label>Name</label>
            <input type="text" id="editName">
            <label>URL</label>
            <input type="text" id="editUrl">
            <div class="modal-actions">
                <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="saveEdit()">Save</button>
            </div>
        </div>
    </div>

    <script>
        let currentType = 0;
        let editingId = null;

        function switchTab(type) {
            currentType = type;
            document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.type) === type));
            loadUrls();
        }

        async function loadUrls() {
            const resp = await fetch(`/api/urls/all?type=${currentType}`);
            const data = await resp.json();
            const list = document.getElementById('urlList');
            const empty = document.getElementById('empty');
            list.innerHTML = '';
            if (data.urls.length === 0) {
                empty.style.display = 'block';
                return;
            }
            empty.style.display = 'none';
            data.urls.forEach(item => {
                const li = document.createElement('li');
                li.className = 'url-item' + (item.enabled ? '' : ' disabled');
                li.innerHTML = `
                    <div class="url-info">
                        <div class="url-name">${esc(item.name || 'Unnamed')}</div>
                        <div class="url-addr">${esc(item.url)}</div>
                    </div>
                    <div class="url-actions">
                        <button class="btn btn-sm btn-toggle ${item.enabled ? 'active' : ''}" onclick="toggleUrl(${item.id}, ${!item.enabled})">${item.enabled ? 'ON' : 'OFF'}</button>
                        <button class="btn btn-sm btn-edit" onclick="openEdit(${item.id}, '${esc(item.name)}', '${esc(item.url)}')">Edit</button>
                        <button class="btn btn-sm btn-delete" onclick="removeUrl(${item.id})">Del</button>
                    </div>
                `;
                list.appendChild(li);
            });
        }

        async function addUrl() {
            const name = document.getElementById('inputName').value.trim();
            const url = document.getElementById('inputUrl').value.trim();
            if (!url) return;
            await fetch('/api/urls', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({type: currentType, name, url})
            });
            document.getElementById('inputName').value = '';
            document.getElementById('inputUrl').value = '';
            loadUrls();
        }

        function openEdit(id, name, url) {
            editingId = id;
            document.getElementById('editName').value = name;
            document.getElementById('editUrl').value = url;
            document.getElementById('editModal').classList.add('show');
        }

        function closeModal() {
            document.getElementById('editModal').classList.remove('show');
            editingId = null;
        }

        async function saveEdit() {
            const name = document.getElementById('editName').value.trim();
            const url = document.getElementById('editUrl').value.trim();
            if (!url) return;
            await fetch(`/api/urls/${editingId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, url})
            });
            closeModal();
            loadUrls();
        }

        async function toggleUrl(id, enabled) {
            await fetch(`/api/urls/${id}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({enabled})
            });
            loadUrls();
        }

        async function removeUrl(id) {
            if (!confirm('Delete this URL?')) return;
            await fetch(`/api/urls/${id}`, {method: 'DELETE'});
            loadUrls();
        }

        function esc(s) {
            const d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        }

        loadUrls();
    </script>
</body>
</html>
```

- [ ] **Step 2: Verify the full service works end-to-end**

Run: `cd /home/projects/TV/manage && python3 -m uvicorn app:app --host 127.0.0.1 --port 18080 &`
Then: `sleep 2 && curl -s http://127.0.0.1:18080/api/urls?type=0 && curl -s -X POST http://127.0.0.1:18080/api/urls -H 'Content-Type: application/json' -d '{"type":0,"name":"test","url":"https://example.com/config.json"}' && curl -s http://127.0.0.1:18080/api/urls?type=0 && kill %1`

Expected: First request returns `{"urls":[]}`, POST returns the created item, third request returns `{"urls":[{"name":"test","url":"https://example.com/config.json"}]}`

- [ ] **Step 3: Commit**

```bash
git add manage/templates/index.html
git commit -m "feat(manage): add web management UI with VOD/Live tabs"
```

---

## Task 4: Android — Add MANAGE Config Type and Static Helpers

**Files:**
- Modify: `app/src/main/java/com/fongmi/android/tv/api/config/BaseConfig.java:29-31`
- Modify: `app/src/main/java/com/fongmi/android/tv/bean/Config.java:87-100`

- [ ] **Step 1: Add `MANAGE = 3` constant to BaseConfig**

In `BaseConfig.java`, after line 31 (`public static final int WALL = 2;`), add:

```java
    public static final int MANAGE = 3;
```

- [ ] **Step 2: Add `Config.manage()` static method to Config.java**

In `Config.java`, after the `wall()` method (line 99), add:

```java
    public static Config manage() {
        Config item = AppDatabase.get().getConfigDao().findOne(3);
        return item == null ? create(3) : item;
    }
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/com/fongmi/android/tv/api/config/BaseConfig.java app/src/main/java/com/fongmi/android/tv/bean/Config.java
git commit -m "feat(android): add MANAGE config type (3) and Config.manage() helper"
```

---

## Task 5: Android — Multi-URL Load and Merge for VodConfig

**Files:**
- Modify: `app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java`

- [ ] **Step 1: Add imports to VodConfig.java**

Add these imports at the top of the file (after existing imports):

```java
import com.github.catvod.net.OkHttp;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
```

- [ ] **Step 2: Add `loadFromManage()` method to VodConfig.java**

Add this method after the existing `load(Config config)` override (after line 116):

```java
    public void loadFromManage(String manageUrl, Callback callback) {
        int id = taskId.incrementAndGet();
        if (future != null && !future.isDone()) future.cancel(true);
        future = Task.submit(() -> loadFromManageConfig(id, manageUrl, callback));
        callback.start();
    }

    private void loadFromManageConfig(int id, String manageUrl, Callback callback) {
        try {
            Server.get().start();
            OkHttp.cancel(getTag());
            String json = OkHttp.string(manageUrl);
            JsonObject resp = Json.parse(json).getAsJsonObject();
            JsonArray urlArray = resp.getAsJsonArray("urls");
            if (urlArray == null || urlArray.isEmpty()) throw new Exception("Manage API returned empty urls");

            List<Site> allSites = new ArrayList<>();
            List<Parse> allParses = new ArrayList<>();
            List<String> allFlags = new ArrayList<>();
            List<String> allAds = new ArrayList<>();
            List<Doh> allDoh = new ArrayList<>();
            List<Rule> allRules = new ArrayList<>();
            LinkedHashSet<String> jars = new LinkedHashSet<>();
            String homeKey = config.getHome();
            boolean firstConfig = true;

            for (JsonElement elem : urlArray) {
                if (taskId.get() != id) return;
                String url = elem.getAsJsonObject().get("url").getAsString();
                try {
                    String configJson = Decoder.getJson(UrlUtil.convert(url), TAG);
                    JsonObject object = Json.parse(configJson).getAsJsonObject();
                    if (object.has("msg")) continue;
                    if (object.has("urls")) continue;

                    String spider = Json.safeString(object, "spider");
                    if (!spider.isEmpty()) jars.add(spider);

                    if (firstConfig) {
                        initList(object);
                        allFlags.addAll(getFlags());
                        allAds.addAll(getAds());
                        allDoh.addAll(getDoh());
                        allRules.addAll(getRules());
                        initLive(config, object);
                        initWall(config, object);
                        firstConfig = false;
                    } else {
                        String extraSpider = Json.safeString(object, "spider");
                        if (!extraSpider.isEmpty()) BaseLoader.get().parseJar(extraSpider, true);
                        allFlags.addAll(Json.safeListString(object, "flags"));
                        allAds.addAll(Json.safeListString(object, "ads"));
                        if (Json.isEmpty(object, "lives")) {
                            Config temp = Config.find(config, LIVE).save();
                            boolean sync = LiveConfig.get().needSync(url);
                            if (sync) LiveConfig.get().config(temp.update()).parse(object);
                        }
                    }

                    List<Site> sites = Json.safeListElement(object, "sites").stream()
                        .map(e -> Site.objectFrom(e, spider))
                        .collect(Collectors.toCollection(ArrayList::new));
                    allSites.addAll(sites);

                    List<Parse> parses = Json.safeListElement(object, "parses").stream()
                        .map(Parse::objectFrom)
                        .collect(Collectors.toCollection(ArrayList::new));
                    allParses.addAll(parses);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            for (String jar : jars) BaseLoader.get().parseJar(jar, true);

            Map<String, Site> deduped = new LinkedHashMap<>();
            for (Site site : allSites) deduped.put(site.getKey(), site);
            setSites(new ArrayList<>(deduped.values()));

            Map<String, Site> items = Site.findAll().stream().collect(Collectors.toMap(Site::getKey, Function.identity()));
            getSites().forEach(site -> site.sync(items.get(site.getKey())));
            setHome(config, getSites().isEmpty() ? new Site() : getSites().stream().filter(item -> item.getKey().equals(homeKey)).findFirst().orElse(getSites().get(0)), false);

            Map<String, Parse> parseMap = new LinkedHashMap<>();
            for (Parse p : allParses) parseMap.put(p.getName(), p);
            setParses(new ArrayList<>(parseMap.values()));
            setParse(config, getParses().isEmpty() ? new Parse() : getParses().stream().filter(item -> item.getName().equals(config.getParse())).findFirst().orElse(getParses().get(0)), false);

            setFlags(new ArrayList<>(new LinkedHashSet<>(allFlags)));
            setAds(new ArrayList<>(new LinkedHashSet<>(allAds)));
            setRules(new ArrayList<>(new LinkedHashSet<>(allRules)));

            if (taskId.get() != id) return;
            if (config.equals(this.config)) config.update();
            App.post(() -> Notify.show(config.getNotice()));
            App.post(callback::success);
        } catch (Throwable e) {
            e.printStackTrace();
            if (isCanceled(e)) return;
            if (taskId.get() != id) return;
            App.post(() -> callback.error(Notify.getError(R.string.error_config_get, e)));
        } finally {
            if (taskId.get() == id) postEvent();
        }
    }
```

- [ ] **Step 3: Verify the file compiles (syntax check)**

Run: `./gradlew :app:compileLeanbackArm64_v8aDebugJavaWithJavac 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL` (or at most unrelated warnings)

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java
git commit -m "feat(android): add multi-URL load and merge for VodConfig"
```

---

## Task 6: Android — Multi-URL Load and Merge for LiveConfig

**Files:**
- Modify: `app/src/main/java/com/fongmi/android/tv/api/config/LiveConfig.java`

- [ ] **Step 1: Add imports to LiveConfig.java**

Add these imports (after existing imports):

```java
import com.github.catvod.net.OkHttp;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import java.util.LinkedHashSet;
```

- [ ] **Step 2: Add `loadFromManage()` method to LiveConfig.java**

Add after the existing `load(Config config)` override (after line 120):

```java
    public void loadFromManage(String manageUrl, Callback callback) {
        int id = taskId.incrementAndGet();
        if (future != null && !future.isDone()) future.cancel(true);
        future = Task.submit(() -> loadFromManageConfig(id, manageUrl, callback));
        callback.start();
    }

    private void loadFromManageConfig(int id, String manageUrl, Callback callback) {
        try {
            Server.get().start();
            OkHttp.cancel(getTag());
            String json = OkHttp.string(manageUrl);
            JsonObject resp = Json.parse(json).getAsJsonObject();
            JsonArray urlArray = resp.getAsJsonArray("urls");
            if (urlArray == null || urlArray.isEmpty()) throw new Exception("Manage API returned empty urls");

            List<Live> allLives = new ArrayList<>();
            List<String> allAds = new ArrayList<>();
            List<Rule> allRules = new ArrayList<>();
            LinkedHashSet<String> jars = new LinkedHashSet<>();
            String homeName = config.getHome();
            boolean firstConfig = true;

            for (JsonElement elem : urlArray) {
                if (taskId.get() != id) return;
                String url = elem.getAsJsonObject().get("url").getAsString();
                try {
                    String configJson = Decoder.getJson(UrlUtil.convert(url), TAG);
                    if (Json.isObj(configJson)) {
                        JsonObject object = Json.parse(configJson).getAsJsonObject();
                        if (object.has("msg")) continue;
                        if (object.has("urls")) continue;

                        String spider = Json.safeString(object, "spider");
                        if (!spider.isEmpty()) jars.add(spider);
                        BaseLoader.get().parseJar(spider, false);

                        if (firstConfig) {
                            initList(object);
                            allAds.addAll(getAds());
                            allRules.addAll(getRules());
                            firstConfig = false;
                        } else {
                            allAds.addAll(Json.safeListString(object, "ads"));
                        }

                        List<Live> lives = Json.safeListElement(object, "lives").stream()
                            .map(e -> Live.objectFrom(e, spider))
                            .collect(Collectors.toCollection(ArrayList::new));
                        allLives.addAll(lives);
                    } else {
                        Live live = new Live(UrlUtil.getName(url), url).sync();
                        LiveParser.text(live, configJson);
                        allLives.add(live);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }

            for (String jar : jars) BaseLoader.get().parseJar(jar, false);

            setLives(allLives.stream().distinct().collect(Collectors.toCollection(ArrayList::new)));
            Map<String, Live> items = Live.findAll().stream().collect(Collectors.toMap(Live::getName, Function.identity()));
            getLives().forEach(live -> live.sync(items.get(live.getName())));
            setHome(config, getLives().isEmpty() ? new Live() : getLives().stream().filter(item -> item.getName().equals(homeName)).findFirst().orElse(getLives().get(0)), false);

            setAds(new ArrayList<>(new LinkedHashSet<>(allAds)));
            setRules(new ArrayList<>(new LinkedHashSet<>(allRules)));

            if (taskId.get() != id) return;
            if (config.equals(this.config)) config.update();
            App.post(callback::success);
        } catch (Throwable e) {
            e.printStackTrace();
            if (isCanceled(e)) return;
            if (taskId.get() != id) return;
            App.post(() -> callback.error(Notify.getError(R.string.error_config_get, e)));
        } finally {
            if (taskId.get() == id) postEvent();
        }
    }
```

- [ ] **Step 3: Verify compilation**

Run: `./gradlew :app:compileLeanbackArm64_v8aDebugJavaWithJavac 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/fongmi/android/tv/api/config/LiveConfig.java
git commit -m "feat(android): add multi-URL load and merge for LiveConfig"
```

---

## Task 7: Android — String Resources for Manage Setting

**Files:**
- Modify: `app/src/main/res/values/strings.xml`
- Modify: `app/src/main/res/values-zh-rCN/strings.xml`
- Modify: `app/src/main/res/values-zh-rTW/strings.xml`

- [ ] **Step 1: Add English string**

In `values/strings.xml`, after the `setting_wall` line:

```xml
    <string name="setting_manage">Manage</string>
```

- [ ] **Step 2: Add Simplified Chinese string**

In `values-zh-rCN/strings.xml`, after the `setting_wall` line:

```xml
    <string name="setting_manage">管理地址</string>
```

- [ ] **Step 3: Add Traditional Chinese string**

In `values-zh-rTW/strings.xml`, after the `setting_wall` line:

```xml
    <string name="setting_manage">管理地址</string>
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/res/values/strings.xml app/src/main/res/values-zh-rCN/strings.xml app/src/main/res/values-zh-rTW/strings.xml
git commit -m "feat(android): add manage setting string resources"
```

---

## Task 8: Android — Settings UI — Leanback Layout

**Files:**
- Modify: `app/src/leanback/res/layout/activity_setting.xml`

- [ ] **Step 1: Add manage URL row after the live row**

In `activity_setting.xml`, insert the following XML block after the live row's closing `</androidx.appcompat.widget.LinearLayoutCompat>` (after the line with `android:id="@+id/liveHistory"`, the entire horizontal LinearLayout for live ends at the next `</androidx.appcompat.widget.LinearLayoutCompat>` that is a sibling of the live LinearLayout):

Find the closing tag of the live section (the horizontal LinearLayout containing `@+id/live` and `@+id/liveHome` and `@+id/liveHistory`). After that closing tag, before the wall section, insert:

```xml
        <androidx.appcompat.widget.LinearLayoutCompat
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="16dp"
            android:gravity="center_vertical"
            android:orientation="horizontal">

            <androidx.appcompat.widget.LinearLayoutCompat
                android:id="@+id/manage"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_marginEnd="16dp"
                android:layout_weight="1"
                android:background="@drawable/selector_item"
                android:focusable="true"
                android:focusableInTouchMode="true"
                android:orientation="horizontal">

                <com.google.android.material.textview.MaterialTextView
                    android:layout_width="0dp"
                    android:layout_height="wrap_content"
                    android:layout_marginEnd="16dp"
                    android:layout_weight="0.3"
                    android:text="@string/setting_manage"
                    android:textColor="@color/white"
                    android:textSize="18sp" />

                <com.google.android.material.textview.MaterialTextView
                    android:id="@+id/manageUrl"
                    android:layout_width="0dp"
                    android:layout_height="wrap_content"
                    android:layout_weight="0.7"
                    android:ellipsize="middle"
                    android:gravity="end"
                    android:singleLine="true"
                    android:textColor="@color/white"
                    android:textSize="18sp"
                    tools:ignore="NestedWeights"
                    tools:text="https://" />

            </androidx.appcompat.widget.LinearLayoutCompat>

        </androidx.appcompat.widget.LinearLayoutCompat>
```

- [ ] **Step 2: Commit**

```bash
git add app/src/leanback/res/layout/activity_setting.xml
git commit -m "feat(android-leanback): add manage URL row to settings layout"
```

---

## Task 9: Android — Settings UI — Mobile Layout

**Files:**
- Modify: `app/src/mobile/res/layout/fragment_setting.xml`

- [ ] **Step 1: Add manage URL row after the live row**

In `fragment_setting.xml`, insert after the live section's closing `</androidx.appcompat.widget.LinearLayoutCompat>` (the horizontal LinearLayout containing `@+id/live`, `@+id/liveHome`, `@+id/liveHistory`), before the wall section:

```xml
            <androidx.appcompat.widget.LinearLayoutCompat
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:layout_marginTop="16dp"
                android:gravity="center_vertical"
                android:orientation="horizontal">

                <androidx.appcompat.widget.LinearLayoutCompat
                    android:id="@+id/manage"
                    android:layout_width="0dp"
                    android:layout_height="wrap_content"
                    android:layout_marginEnd="12dp"
                    android:layout_weight="1"
                    android:background="@drawable/shape_item"
                    android:orientation="horizontal">

                    <com.google.android.material.textview.MaterialTextView
                        android:layout_width="wrap_content"
                        android:layout_height="wrap_content"
                        android:layout_marginEnd="16dp"
                        android:text="@string/setting_manage"
                        android:textColor="@color/white"
                        android:textSize="16sp" />

                    <com.google.android.material.textview.MaterialTextView
                        android:id="@+id/manageUrl"
                        android:layout_width="match_parent"
                        android:layout_height="wrap_content"
                        android:ellipsize="middle"
                        android:gravity="end"
                        android:singleLine="true"
                        android:textColor="@color/white"
                        android:textSize="16sp"
                        tools:text="https://" />

                </androidx.appcompat.widget.LinearLayoutCompat>

            </androidx.appcompat.widget.LinearLayoutCompat>
```

- [ ] **Step 2: Commit**

```bash
git add app/src/mobile/res/layout/fragment_setting.xml
git commit -m "feat(android-mobile): add manage URL row to settings layout"
```

---

## Task 10: Android — Settings Logic — Leanback SettingActivity

**Files:**
- Modify: `app/src/leanback/java/com/fongmi/android/tv/ui/activity/SettingActivity.java`

- [ ] **Step 1: Add `Config.manage()` import and manage-related methods**

In `SettingActivity.java`, add import if not already present:

```java
import com.fongmi.android.tv.bean.Config;
```

(Note: Config is already imported, so no action needed for imports.)

- [ ] **Step 2: Add manage URL display in `initView`**

In the `initView` method, after `mBinding.wallUrl.setText(WallConfig.getDesc());` (line 86), add:

```java
        Config manageConfig = Config.manage();
        mBinding.manageUrl.setText(manageConfig.isEmpty() ? "" : manageConfig.getDesc());
```

- [ ] **Step 3: Add manage click handler in `initEvent`**

In the `initEvent` method, after `mBinding.liveHistory.setOnClickListener(this::onLiveHistory);` (line 126), add:

```java
        mBinding.manage.setOnClickListener(this::onManage);
```

- [ ] **Step 4: Add `onManage` method**

After the `onLive` method (line 192-193), add:

```java
    private void onManage(View view) {
        ConfigDialog.create(this).launcher(launcher).type(type = 3).show();
    }
```

- [ ] **Step 5: Update `load` switch to handle type 3**

In the `load` method (line 141-154), add a case before the closing `}` of the switch:

```java
            case 3:
                String manageUrl = config.getUrl();
                if (manageUrl.contains("?")) manageUrl = manageUrl.split("\\?")[0] + "?type=0";
                else manageUrl = manageUrl + (manageUrl.endsWith("/") ? "" : "/") + "api/urls?type=0";
                VodConfig.get().loadFromManage(manageUrl, getCallback());
                String manageLiveUrl = manageUrl.replace("type=0", "type=1");
                LiveConfig.get().loadFromManage(manageLiveUrl, new Callback() {
                    @Override public void start() {}
                    @Override public void success() {}
                    @Override public void error(String msg) {}
                });
                break;
```

- [ ] **Step 6: Update `onConfigEvent` to refresh manage URL display**

In the `onConfigEvent` method (line 322-327), after `mBinding.wallUrl.setText(WallConfig.getDesc());`, add:

```java
        Config manageConfig = Config.manage();
        mBinding.manageUrl.setText(manageConfig.isEmpty() ? "" : manageConfig.getDesc());
```

- [ ] **Step 7: Verify compilation**

Run: `./gradlew :app:compileLeanbackArm64_v8aDebugJavaWithJavac 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 8: Commit**

```bash
git add app/src/leanback/java/com/fongmi/android/tv/ui/activity/SettingActivity.java
git commit -m "feat(android-leanback): wire up manage URL setting in SettingActivity"
```

---

## Task 11: Android — Settings Logic — Mobile SettingFragment

**Files:**
- Modify: `app/src/mobile/java/com/fongmi/android/tv/ui/fragment/SettingFragment.java`

- [ ] **Step 1: Add manage URL display in `initView`**

In the `initView` method, after `mBinding.wallUrl.setText(WallConfig.getDesc());` (line 94), add:

```java
        Config manageConfig = Config.manage();
        mBinding.manageUrl.setText(manageConfig.isEmpty() ? "" : manageConfig.getDesc());
```

- [ ] **Step 2: Add manage click handler in `initEvent`**

In the `initEvent` method, after `mBinding.liveHistory.setOnClickListener(this::onLiveHistory);` (line 134), add:

```java
        mBinding.manage.setOnClickListener(this::onManage);
```

- [ ] **Step 3: Add `onManage` method**

After the `onLive` method (line 199-201), add:

```java
    private void onManage(View view) {
        ConfigDialog.create(this).launcher(launcher).type(type = 3).show();
    }
```

- [ ] **Step 4: Update `load` switch to handle type 3**

In the `load` method (line 149-162), add a case before the closing `}` of the switch:

```java
            case 3:
                String manageUrl = config.getUrl();
                if (manageUrl.contains("?")) manageUrl = manageUrl.split("\\?")[0] + "?type=0";
                else manageUrl = manageUrl + (manageUrl.endsWith("/") ? "" : "/") + "api/urls?type=0";
                VodConfig.get().loadFromManage(manageUrl, getCallback());
                String manageLiveUrl = manageUrl.replace("type=0", "type=1");
                LiveConfig.get().loadFromManage(manageLiveUrl, new Callback() {
                    @Override public void start() {}
                    @Override public void success() {}
                    @Override public void error(String msg) {}
                });
                break;
```

- [ ] **Step 5: Update `onConfigEvent` to refresh manage URL display**

In the `onConfigEvent` method (line 334-339), after `mBinding.wallUrl.setText(WallConfig.getDesc());`, add:

```java
        Config manageConfig = Config.manage();
        mBinding.manageUrl.setText(manageConfig.isEmpty() ? "" : manageConfig.getDesc());
```

- [ ] **Step 6: Verify compilation**

Run: `./gradlew :app:compileMobileArm64_v8aDebugJavaWithJavac 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 7: Commit**

```bash
git add app/src/mobile/java/com/fongmi/android/tv/ui/fragment/SettingFragment.java
git commit -m "feat(android-mobile): wire up manage URL setting in SettingFragment"
```

---

## Task 12: Android — Update ConfigDialog for Type 3

**Files:**
- Modify: `app/src/leanback/java/com/fongmi/android/tv/ui/dialog/ConfigDialog.java`
- Modify: `app/src/mobile/java/com/fongmi/android/tv/ui/dialog/ConfigDialog.java`

- [ ] **Step 1: Update leanback ConfigDialog's `getConfig()` to handle type 3**

In the leanback `ConfigDialog.java`, in the `getConfig()` method (line 94-105), add a case:

```java
            case 3:
                return Config.manage();
```

- [ ] **Step 2: Update leanback ConfigDialog's `initDialog()` title for type 3**

In the leanback `ConfigDialog.java`, in the `initDialog()` method (line 68), the title is set via ternary. Change it to handle type 3:

Replace:
```java
.setTitle(type == 0 ? R.string.setting_vod : type == 1 ? R.string.setting_live : R.string.setting_wall)
```

With:
```java
.setTitle(type == 0 ? R.string.setting_vod : type == 1 ? R.string.setting_live : type == 2 ? R.string.setting_wall : R.string.setting_manage)
```

- [ ] **Step 3: Update mobile ConfigDialog's `getUrl()` to handle type 3**

In the mobile `ConfigDialog.java`, in the `getUrl()` method (line 111-122), add a case:

```java
            case 3:
                Config manageConfig = Config.manage();
                return manageConfig.getUrl();
```

- [ ] **Step 4: Verify compilation**

Run: `./gradlew :app:compileLeanbackArm64_v8aDebugJavaWithJavac :app:compileMobileArm64_v8aDebugJavaWithJavac 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add app/src/leanback/java/com/fongmi/android/tv/ui/dialog/ConfigDialog.java app/src/mobile/java/com/fongmi/android/tv/ui/dialog/ConfigDialog.java
git commit -m "feat(android): update ConfigDialog to handle manage type (3)"
```

---

## Task 13: Full Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Clean build both variants**

Run: `./gradlew assembleRelease 2>&1 | tail -10`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: Verify APK output**

Run: `ls -la Release/apk/ 2>/dev/null || ls -la app/build/outputs/apk/`
Expected: APK files for both leanback and mobile variants
