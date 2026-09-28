package com.fongmi.android.tv.server;

import android.text.TextUtils;

import com.fongmi.android.tv.App;
import com.fongmi.android.tv.BuildConfig;
import com.fongmi.android.tv.Constant;
import com.fongmi.android.tv.api.WebApi;
import com.fongmi.android.tv.api.config.LiveConfig;
import com.fongmi.android.tv.api.config.VodConfig;
import com.fongmi.android.tv.bean.Config;
import com.fongmi.android.tv.bean.Site;
import com.fongmi.android.tv.impl.Callback;
import com.fongmi.android.tv.utils.Notify;
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
import java.util.concurrent.Semaphore;
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
    private final Map<Integer, Fetcher> fetchers;
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
        fetchers = new ConcurrentHashMap<>();
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
                hello.addProperty("fetchFlow", true);
                webSocket.send(hello.toString());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    // 管理端推送的配置变更（无 action/id）：按 vod/live/all 重载对应配置
                    if ("configChanged".equals(msg.optString("type"))) {
                        String config = msg.optString("config");
                        if ("vod".equals(config) || "all".equals(config)) reload(0);
                        if ("live".equals(config) || "all".equals(config)) reload(1);
                        return;
                    }
                    int id = msg.optInt("id");
                    String action = msg.optString("action");
                    JSONObject params = msg.optJSONObject("params");
                    if ("fetch".equals(action)) {
                        // 收到时立即登记，随后到达的 cancelFetch 不会因执行器调度而丢失。
                        handle(webSocket, id, action, params);
                        return;
                    }
                    // 控制帧在接收线程处理，避免下载占满执行器时无法取消或确认。
                    if ("fetchAck".equals(action) || "cancelFetch".equals(action)) {
                        Fetcher fetcher = fetchers.get(params.optInt("fetchId"));
                        if (fetcher != null && fetcher.webSocket == webSocket) {
                            if ("cancelFetch".equals(action)) fetcher.cancel();
                            else fetcher.ack();
                        }
                        return;
                    }
                    executor.execute(() -> handle(webSocket, id, action, params));
                } catch (Exception e) {
                    SpiderDebug.log("bridge", "bad message %s", e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                cancelSearches(webSocket);
                cancelFetches(webSocket);
                closed.countDown();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                cancelSearches(webSocket);
                cancelFetches(webSocket);
                closed.countDown();
            }
        };
    }

    /** 管理端推送配置变更后的动态重载：与 HomeActivity.initConfig 同口径拉取聚合配置。
     * loadFromManage 自带 taskId 取消机制，连续推送只保留最后一次；加载完成后
     * postEvent 发 ConfigEvent，各端 HomeActivity 已订阅自动刷新界面。 */
    private void reload(int type) {
        String url = Config.manageApi(type);
        if (TextUtils.isEmpty(url)) return;
        Callback callback = new Callback() {
            @Override
            public void error(String msg) {
                Notify.show(msg);
            }
        };
        SpiderDebug.log("bridge", "reload config type=%d", type);
        if (type == 0) VodConfig.get().init().loadFromManage(url, callback);
        else LiveConfig.get().init().loadFromManage(url, callback);
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
                    Fetcher fetcher = new Fetcher(webSocket, id, params);
                    Fetcher previousFetcher = fetchers.put(id, fetcher);
                    if (previousFetcher != null) previousFetcher.cancel();
                    executor.execute(fetcher);
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
    private void cancelFetches(WebSocket socket) {
        for (Fetcher fetcher : fetchers.values()) {
            if (fetcher.webSocket == socket) fetcher.cancel();
        }
    }

    private class Fetcher implements Runnable {

        private final WebSocket webSocket;
        private final int id;
        private final String url;
        private final Map<String, String> headers;
        private final String range;
        private final boolean flowControl;
        private final String resolvedIp;
        private final Semaphore credits = new Semaphore(8);
        private volatile boolean cancelled;
        private volatile okhttp3.Call call;

        void ack() { if (credits.availablePermits() < 8) credits.release(); }

        void cancel() {
            cancelled = true;
            okhttp3.Call current = call;
            if (current != null) current.cancel();
            credits.release();
        }

        Fetcher(WebSocket webSocket, int id, JSONObject params) {
            this.webSocket = webSocket;
            this.id = id;
            this.url = params.optString("url");
            this.range = params.optString("range");
            this.flowControl = params.optBoolean("flowControl", false);
            this.resolvedIp = params.optString("resolvedIp");
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
                OkHttpClient.Builder clientBuilder = OkHttp.client().newBuilder().readTimeout(60, TimeUnit.SECONDS);
                if (flowControl) {
                    // 缓存由服务端逐跳检查重定向，并固定通过校验的公网 IP。
                    clientBuilder.followRedirects(false).followSslRedirects(false);
                    if (!TextUtils.isEmpty(resolvedIp)) {
                        String expectedHost = builder.build().url().host();
                        clientBuilder.dns(host -> {
                            if (!host.equals(expectedHost)) throw new java.net.UnknownHostException("unexpected download host");
                            return java.util.Collections.singletonList(java.net.InetAddress.getByName(resolvedIp));
                        });
                    }
                }
                OkHttpClient client = clientBuilder.build();
                call = client.newCall(builder.build());
                if (cancelled) throw new IOException("fetch cancelled");
                response = call.execute();
                JSONObject meta = new JSONObject();
                meta.put("id", id);
                meta.put("type", "meta");
                meta.put("status", response.code());
                // 重定向后的最终地址：服务端改写 m3u8 相对路径时需要正确基准
                meta.put("url", response.request().url().toString());
                JSONObject rh = new JSONObject();
                for (String name : new String[]{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Location"}) {
                    String value = response.header(name);
                    if (!TextUtils.isEmpty(value)) rh.put(name, value);
                }
                meta.put("headers", rh);
                if (!webSocket.send(meta.toString())) throw new IOException("ws closed");
                InputStream in = response.body().byteStream();
                byte[] head = ByteBuffer.allocate(4).putInt(id).array();
                byte[] buffer = new byte[64 * 1024];
                while (true) {
                    if (flowControl && !credits.tryAcquire(60, TimeUnit.SECONDS)) throw new IOException("fetch ack timeout");
                    if (cancelled) throw new IOException("fetch cancelled");
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
                fetchers.remove(id, this);
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
