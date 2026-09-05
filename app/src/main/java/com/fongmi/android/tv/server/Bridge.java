package com.fongmi.android.tv.server;

import android.text.TextUtils;

import com.fongmi.android.tv.App;
import com.fongmi.android.tv.BuildConfig;
import com.fongmi.android.tv.Constant;
import com.fongmi.android.tv.api.WebApi;
import com.fongmi.android.tv.api.config.VodConfig;
import com.fongmi.android.tv.bean.Config;
import com.fongmi.android.tv.bean.Site;
import com.fongmi.android.tv.utils.Task;
import com.fongmi.android.tv.utils.Util;
import com.github.catvod.crawler.SpiderDebug;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Prefers;
import com.google.common.util.concurrent.FluentFuture;
import com.google.common.util.concurrent.MoreExecutors;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * 互联网版桥接（设备侧）：主动向服务端（manage 配置地址 + /ws）建立 WebSocket 长连接，
 * 接收搜索/详情/取播放地址等命令并回包；fetch 命令在设备上取流，
 * 以「4 字节请求 id + 数据块」的二进制帧回传，供服务端转交给浏览器。
 * 流控依赖 OkHttp 的 WS 发送队列上限（send 返回 false 即连接已亡，中止取流）。
 */
public class Bridge {

    private final ExecutorService executor;
    private final Map<Integer, SearchSession> searches;
    private volatile WebSocket ws;
    private volatile boolean running;
    private volatile String override;

    private static class Loader {
        static final Bridge INSTANCE = new Bridge();
    }

    public static Bridge get() {
        return Loader.INSTANCE;
    }

    private Bridge() {
        executor = Executors.newCachedThreadPool();
        searches = new ConcurrentHashMap<>();
    }

    public void start() {
        if (running) return;
        running = true;
        new Thread(this::loop, "Bridge").start();
    }

    /**
     * 调试覆盖地址（BridgeReceiver 广播设置），非空时优先于设置页的 manage 地址。
     * 变更后立即断开当前连接让循环用新地址重连。
     */
    public void setOverride(String url) {
        override = TextUtils.isEmpty(url) ? null : url;
        WebSocket socket = ws;
        if (socket != null) socket.close(1000, "override changed");
        SpiderDebug.log("bridge", "override %s", override);
    }

    public boolean isOnline() {
        return ws != null;
    }

    /**
     * 持久设备 id：首次生成 UUID 存入 SharedPreferences，重装才会变化。
     * 服务端以此区分不同安装实例（连接中/历史设备、选择搜索来源）。
     */
    private String deviceId() {
        String id = Prefers.getString("bridge_device_id");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
            Prefers.put("bridge_device_id", id);
        }
        return id;
    }

    private void loop() {
        int delay = 5;
        while (running) {
            String target = override;
            if (TextUtils.isEmpty(target)) target = Config.manage().getUrl();
            if (TextUtils.isEmpty(target)) {
                sleep(30_000);
                continue;
            }
            try {
                CountDownLatch closed = new CountDownLatch(1);
                SpiderDebug.log("bridge", "connect %s", wsUrl(target));
                OkHttpClient client = OkHttp.client().newBuilder().pingInterval(20, TimeUnit.SECONDS).build();
                Request request = new Request.Builder().url(wsUrl(target)).build();
                WebSocket socket = client.newWebSocket(request, listener(closed));
                synchronized (this) { ws = socket; }
                closed.await();
                synchronized (this) { if (ws == socket) ws = null; }
                SpiderDebug.log("bridge", "disconnected");
            } catch (Throwable e) {
                SpiderDebug.log("bridge", "error %s", e.getMessage());
            }
            sleep(delay * 1000L);
            delay = Math.min(delay * 2, 60);
        }
    }

    private WebSocketListener listener(CountDownLatch closed) {
        return new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                JsonObject hello = new JsonObject();
                hello.addProperty("type", "hello");
                hello.addProperty("id", deviceId());
                hello.addProperty("device", Util.getDeviceName());
                hello.addProperty("version", BuildConfig.VERSION_NAME);
                webSocket.send(hello.toString());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    int id = msg.optInt("id");
                    String action = msg.optString("action");
                    JSONObject params = msg.optJSONObject("params");
                    executor.execute(() -> handle(webSocket, id, action, params));
                } catch (Exception e) {
                    SpiderDebug.log("bridge", "bad message %s", e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                cancelSearches(webSocket);
                closed.countDown();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                cancelSearches(webSocket);
                closed.countDown();
            }
        };
    }

    private void handle(WebSocket webSocket, int id, String action, JSONObject params) {
        try {
            JsonObject data;
            switch (action) {
                case "sites":
                    data = WebApi.sites();
                    break;
                case "home":
                    data = WebApi.home(params.optString("key"));
                    break;
                case "category":
                    data = WebApi.category(params.optString("key"), params.optString("tid"), params.optString("pg"));
                    break;
                case "search":
                    data = WebApi.search(params.optString("key"), params.optString("wd"), params.optBoolean("quick", false));
                    break;
                case "searchAll":
                    startSearchAll(webSocket, id, params);
                    return;
                case "cancelSearch":
                    cancelSearch(params.optInt("searchId"));
                    data = new JsonObject();
                    data.addProperty("ok", true);
                    break;
                case "detail":
                    data = WebApi.detail(params.optString("key"), params.optString("id"));
                    break;
                case "player":
                    data = WebApi.player(params.optString("key"), params.optString("flag"), params.optString("id"));
                    break;
                case "liveList":
                    data = WebApi.liveList(params.optString("live"));
                    break;
                case "livePlay":
                    data = WebApi.livePlay(params.optString("live"), params.optString("group"), params.optString("channel"), params.optInt("line", 0));
                    break;
                case "liveEpg":
                    data = WebApi.liveEpg(params.optString("live"), params.optString("group"), params.optString("channel"));
                    break;
                case "fetch":
                    executor.execute(new Fetcher(webSocket, id, params));
                    return;
                default:
                    reply(webSocket, id, "unknown action " + action);
                    return;
            }
            reply(webSocket, id, data);
        } catch (Throwable e) {
            reply(webSocket, id, e.getMessage());
        }
    }

    private void startSearchAll(WebSocket webSocket, int id, JSONObject params) {
        SearchSession session = new SearchSession(webSocket, id, params);
        SearchSession previous = searches.put(id, session);
        if (previous != null) previous.cancel();
        try {
            session.start();
        } catch (RuntimeException e) {
            session.cancel();
            throw e;
        }
    }

    private void cancelSearch(int id) {
        SearchSession session = searches.remove(id);
        if (session != null) session.cancel();
    }

    private void cancelSearches(WebSocket webSocket) {
        for (SearchSession session : new ArrayList<>(searches.values())) {
            if (session.webSocket == webSocket) session.cancel();
        }
    }

    /**
     * 一次 searchAll 对应一个 App 内搜索批次。站点筛选、20 线程并发及单站超时与
     * 原生搜索共用 Task.largeExecutor；每站结束立即回一条 site，全部结束回 done。
     */
    private class SearchSession {

        private final WebSocket webSocket;
        private final int id;
        private final String keyword;
        private final String preferred;
        private final boolean quick;
        private final Set<String> disabled;
        private final List<Future<?>> futures;
        private final AtomicBoolean cancelled;
        private final AtomicInteger remaining;
        private int searched;

        SearchSession(WebSocket webSocket, int id, JSONObject params) {
            this.webSocket = webSocket;
            this.id = id;
            this.keyword = params.optString("wd");
            this.preferred = params.optString("preferred");
            this.quick = params.optBoolean("quick", true);
            this.disabled = new HashSet<>();
            this.futures = new CopyOnWriteArrayList<>();
            this.cancelled = new AtomicBoolean(false);
            this.remaining = new AtomicInteger(0);
            JSONArray array = params.optJSONArray("disabled");
            if (array != null) for (int i = 0; i < array.length(); i++) disabled.add(array.optString(i));
        }

        synchronized void start() {
            List<Site> available = new ArrayList<>();
            for (Site site : VodConfig.get().getSites()) {
                if (site.isHide() || !site.isSearchable()) continue;
                if (quick && !site.isQuickSearch()) continue;
                available.add(site);
            }
            List<Site> sites = new ArrayList<>();
            for (Site site : available) if (!disabled.contains(site.getKey())) sites.add(site);
            if (!TextUtils.isEmpty(preferred)) {
                sites.sort((a, b) -> Boolean.compare(!a.getKey().equals(preferred), !b.getKey().equals(preferred)));
            }
            searched = sites.size();
            remaining.set(searched);
            sendMeta(available);
            if (cancelled.get()) return;
            if (sites.isEmpty()) {
                sendDone();
                return;
            }
            for (Site site : sites) {
                FluentFuture<JsonObject> future = FluentFuture
                        .from(Task.largeExecutor().submit(() -> WebApi.search(site.getKey(), keyword, quick)))
                        .withTimeout(Constant.TIMEOUT_SEARCH, TimeUnit.MILLISECONDS, Task.scheduler());
                futures.add(future);
                future.addCallback(Task.callback(
                        data -> siteDone(site, data, null),
                        error -> siteDone(site, emptyResult(), error)
                ), MoreExecutors.directExecutor());
            }
        }

        private JsonObject emptyResult() {
            JsonObject data = new JsonObject();
            data.add("list", new JsonArray());
            return data;
        }

        private void sendMeta(List<Site> available) {
            try {
                JSONObject msg = event("meta");
                msg.put("sites", searched);
                JSONArray array = new JSONArray();
                for (Site site : available) {
                    JSONObject item = new JSONObject();
                    item.put("key", site.getKey());
                    item.put("name", site.getName());
                    array.put(item);
                }
                msg.put("availableSites", array);
                send(msg);
            } catch (Exception e) {
                cancel();
            }
        }

        private void siteDone(Site site, JsonObject data, Throwable error) {
            if (cancelled.get()) return;
            try {
                JSONObject msg = event("site");
                msg.put("siteKey", site.getKey());
                msg.put("siteName", site.getName());
                msg.put("data", new JSONObject(data.toString()));
                if (error != null && !TextUtils.isEmpty(error.getMessage())) msg.put("error", error.getMessage());
                send(msg);
            } catch (Exception e) {
                cancel();
                return;
            }
            if (remaining.decrementAndGet() == 0) sendDone();
        }

        private void sendDone() {
            if (!cancelled.compareAndSet(false, true)) return;
            searches.remove(id, this);
            try {
                JSONObject msg = event("done");
                msg.put("searched", searched);
                webSocket.send(msg.toString());
            } catch (Exception ignored) {
            }
            futures.clear();
        }

        private JSONObject event(String type) throws Exception {
            JSONObject msg = new JSONObject();
            msg.put("id", id);
            msg.put("type", type);
            return msg;
        }

        private void send(JSONObject msg) throws IOException {
            if (cancelled.get() || !webSocket.send(msg.toString())) throw new IOException("ws closed");
        }

        synchronized void cancel() {
            if (!cancelled.compareAndSet(false, true)) return;
            searches.remove(id, this);
            for (Future<?> future : futures) future.cancel(true);
            futures.clear();
        }
    }

    private void reply(WebSocket webSocket, int id, JsonObject data) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("id", id);
            msg.put("ok", true);
            msg.put("data", new JSONObject(data.toString()));
            webSocket.send(msg.toString());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void reply(WebSocket webSocket, int id, String error) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("id", id);
            msg.put("ok", false);
            msg.put("error", TextUtils.isEmpty(error) ? "error" : error);
            webSocket.send(msg.toString());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /**
     * 设备侧取流：请求源站（含设备本地 /proxy 地址），把状态/响应头以 meta 帧回传，
     * 之后分块以「4 字节 id + 数据」二进制帧回传，以 end/error 帧收尾。
     */
    private static class Fetcher implements Runnable {

        private final WebSocket webSocket;
        private final int id;
        private final String url;
        private final Map<String, String> headers;
        private final String range;

        Fetcher(WebSocket webSocket, int id, JSONObject params) {
            this.webSocket = webSocket;
            this.id = id;
            this.url = params.optString("url");
            this.range = params.optString("range");
            JSONObject h = params.optJSONObject("headers");
            this.headers = h == null ? new HashMap<>() : App.gson().fromJson(h.toString(), new com.google.gson.reflect.TypeToken<Map<String, String>>() {}.getType());
        }

        @Override
        public void run() {
            Response response = null;
            try {
                Request.Builder builder = new Request.Builder().url(url).get();
                for (Map.Entry<String, String> entry : headers.entrySet()) builder.header(entry.getKey(), entry.getValue());
                if (!TextUtils.isEmpty(range)) builder.header("Range", range);
                OkHttpClient client = OkHttp.client().newBuilder().readTimeout(60, TimeUnit.SECONDS).build();
                response = client.newCall(builder.build()).execute();
                JSONObject meta = new JSONObject();
                meta.put("id", id);
                meta.put("type", "meta");
                meta.put("status", response.code());
                // 重定向后的最终地址：服务端改写 m3u8 相对路径时需要正确基准
                meta.put("url", response.request().url().toString());
                JSONObject rh = new JSONObject();
                for (String name : new String[]{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"}) {
                    String value = response.header(name);
                    if (!TextUtils.isEmpty(value)) rh.put(name, value);
                }
                meta.put("headers", rh);
                if (!webSocket.send(meta.toString())) throw new IOException("ws closed");
                InputStream in = response.body().byteStream();
                byte[] head = ByteBuffer.allocate(4).putInt(id).array();
                byte[] buffer = new byte[64 * 1024];
                while (true) {
                    int read = in.read(buffer);
                    if (read < 0) break;
                    byte[] frame = new byte[4 + read];
                    System.arraycopy(head, 0, frame, 0, 4);
                    System.arraycopy(buffer, 0, frame, 4, read);
                    if (!webSocket.send(ByteString.of(frame))) throw new IOException("ws closed");
                }
                JSONObject end = new JSONObject();
                end.put("id", id);
                end.put("type", "end");
                webSocket.send(end.toString());
            } catch (Throwable e) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("id", id);
                    err.put("type", "error");
                    err.put("error", e.getMessage());
                    webSocket.send(err.toString());
                } catch (Exception ignored) {
                }
            } finally {
                if (response != null) response.close();
            }
        }
    }

    private String wsUrl(String url) {
        url = url.split("#")[0].trim();
        if (url.startsWith("https")) url = "wss" + url.substring(5);
        else if (url.startsWith("http")) url = "ws" + url.substring(4);
        if (!url.endsWith("/")) url += "/";
        return url + "ws";
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
