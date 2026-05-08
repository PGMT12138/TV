# Multi-URL Management Service Design

## Overview

Add a Python management service and modify the Android app to support loading and merging configurations from multiple URLs. A management web page allows configuring multiple VOD and Live source URLs. The app requests the URL list from the management service, fetches each config, and merges them into a unified source list.

## Part 1: Python Management Service

### Tech Stack

FastAPI + SQLite + Jinja2, deployed as a single directory.

### Data Model

Single `urls` table:

| Field       | Type       | Description                  |
|-------------|------------|------------------------------|
| id          | INTEGER PK | Auto-increment               |
| type        | INTEGER    | 0=VOD, 1=Live                |
| name        | TEXT       | Display name (optional)      |
| url         | TEXT       | Config URL                   |
| sort        | INTEGER    | Sort order                   |
| enabled     | BOOLEAN    | Enabled flag, default true   |
| created_at  | TIMESTAMP  | Creation time                |

### API Endpoints

| Method | Path             | Description                            |
|--------|------------------|----------------------------------------|
| GET    | `/`              | Management page (HTML)                 |
| GET    | `/api/urls?type=` | Get URL list by type (app-facing)     |
| POST   | `/api/urls`      | Create URL (management page)           |
| PUT    | `/api/urls/{id}` | Update URL                             |
| DELETE | `/api/urls/{id}` | Delete URL                             |

**`GET /api/urls?type=0` response format:**

```json
{
  "urls": [
    {"name": "Source 1", "url": "https://xxx/config.json"},
    {"name": "Source 2", "url": "https://yyy/config.json"}
  ]
}
```

Only returns `enabled=true` records, sorted by `sort` ascending.

### Management Page

Single-page HTML rendered by Jinja2, with two tabs (VOD / Live). Each tab supports add, edit, delete, and reorder of URLs. Uses vanilla JS and CSS, no frontend framework.

### Project Structure

```
manage/
  app.py              # FastAPI application entry point
  database.py         # SQLite database operations
  templates/
    index.html        # Management page template
  requirements.txt    # Python dependencies
```

## Part 2: Android App Changes

### New Config Type

Add `MANAGE = 3` to Config type constants. The settings page gets a new "Management URL" input that stores the management service's `/api/urls` endpoint address as a Config entity with `type=3`.

### Loading Flow

**Current flow:**
User enters single URL → `VodConfig.load(config)` → fetch URL → parse sites

**New flow:**
1. User configures management address (saved as Config type=3)
2. On app start or config switch, app requests management API to get URL list
3. If management address is valid and returns multiple URLs → fetch each URL's config JSON → merge all sites/lives
4. If management address is empty or request fails → fall back to original single-URL logic

### Merge Rules

**VOD (sites):**
- `sites` arrays are concatenated in URL list order
- Deduplicated by `key` — later entries overwrite earlier ones
- Spider JARs: union of all JARs
- `parses`, `flags`, `ads`, `doh`, `rules`: merged and deduplicated

**Live (lives):**
- `lives` arrays are simply concatenated, no deduplication
- Different sources may have same channel names with different stream URLs

### Key Files to Modify

| File | Change |
|------|--------|
| `VodConfig.java` | Add `loadFromManage()` — fetch URL list, load each, merge |
| `LiveConfig.java` | Same pattern for live configs |
| `Config.java` | Add `MANAGE = 3` constant |
| `BaseConfig.java` | Add `MANAGE = 3` constant |
| `SettingActivity.java` (leanback) | Add management URL input entry |
| `SettingFragment.java` (mobile) | Same |
| `dialog_config.xml` (leanback + mobile) | Adapt if needed |

### Fallback Mechanism

Management address and original single-URL config coexist. If the management address is not configured or the request fails, the app uses the original single-URL config as before. Users can choose management mode or traditional single-URL mode.

## Deployment

The Python service is designed for public server deployment with no authentication. It runs as a standalone process (e.g., `uvicorn manage.app:app --host 0.0.0.0 --port 8000`).
