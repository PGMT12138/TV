package com.fongmi.android.tv.api;

import android.text.TextUtils;

import com.fongmi.android.tv.App;
import com.fongmi.android.tv.api.config.LiveConfig;
import com.fongmi.android.tv.api.config.VodConfig;
import com.fongmi.android.tv.bean.Channel;
import com.fongmi.android.tv.bean.Class;
import com.fongmi.android.tv.bean.Epg;
import com.fongmi.android.tv.bean.EpgData;
import com.fongmi.android.tv.bean.Episode;
import com.fongmi.android.tv.bean.Flag;
import com.fongmi.android.tv.bean.Group;
import com.fongmi.android.tv.bean.Live;
import com.fongmi.android.tv.bean.Result;
import com.fongmi.android.tv.bean.Site;
import com.fongmi.android.tv.bean.Vod;
import com.fongmi.android.tv.impl.ParseCallback;
import com.fongmi.android.tv.player.ParseJob;
import com.fongmi.android.tv.server.Server;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 网页观看的共享业务层：把 SiteApi 的调用结果组装成前端需要的 JSON。
 * 局域网版（server.process.Api 直接 HTTP 暴露）和互联网版（server.Bridge 经 WebSocket 暴露）共用，
 * 区别仅在传输层——player 的 play 字段由各传输层自行拼接。
 */
public class WebApi {

    private static final long TIMEOUT_SNIFF = TimeUnit.SECONDS.toMillis(25);

    public static JsonObject sites() {
        JsonArray array = new JsonArray();
        for (Site site : VodConfig.get().getSites()) {
            if (site.isHide()) continue;
            JsonObject item = new JsonObject();
            item.addProperty("key", site.getKey());
            item.addProperty("name", site.getName());
            item.addProperty("searchable", site.isSearchable());
            array.add(item);
        }
        JsonObject data = new JsonObject();
        data.addProperty("config", VodConfig.getUrl());
        data.add("sites", array);
        return data;
    }

    public static JsonObject home(String key) throws Exception {
        Site site = site(key);
        Result result = SiteApi.homeContent(site);
        JsonObject data = new JsonObject();
        data.addProperty("siteKey", site.getKey());
        data.addProperty("siteName", site.getName());
        JsonArray types = new JsonArray();
        for (Class type : result.getTypes()) {
            JsonObject item = new JsonObject();
            item.addProperty("id", type.getTypeId());
            item.addProperty("name", type.getTypeName());
            types.add(item);
        }
        data.add("types", types);
        JsonArray list = new JsonArray();
        for (Vod vod : result.getList()) vodCard(list, site, vod);
        data.add("list", list);
        return data;
    }

    public static JsonObject category(String key, String tid, String pg) throws Exception {
        Site site = site(key);
        Result result = SiteApi.categoryContent(key, tid, TextUtils.isEmpty(pg) ? "1" : pg, false, new HashMap<>());
        JsonObject data = new JsonObject();
        data.addProperty("siteKey", key);
        data.addProperty("siteName", site.getName());
        data.addProperty("tid", tid);
        data.addProperty("pageCount", result.getPageCount());
        JsonArray list = new JsonArray();
        for (Vod vod : result.getList()) vodCard(list, site, vod);
        data.add("list", list);
        return data;
    }

    public static JsonObject search(String key, String wd) throws Exception {
        Site site = site(key);
        Result result = SiteApi.searchContent(site, wd, false, "1");
        JsonArray array = new JsonArray();
        for (Vod vod : result.getList()) vodCard(array, site, vod);
        JsonObject data = new JsonObject();
        data.add("list", array);
        return data;
    }

    public static JsonObject detail(String key, String id) throws Exception {
        Result result = SiteApi.detailContent(key, id);
        Vod vod = result.getVod();
        JsonObject data = new JsonObject();
        data.addProperty("siteKey", key);
        data.addProperty("id", vod.getId());
        data.addProperty("name", vod.getName());
        data.addProperty("pic", vod.getPic());
        data.addProperty("remarks", vod.getRemarks());
        data.addProperty("year", vod.getYear());
        data.addProperty("area", vod.getArea());
        data.addProperty("typeName", vod.getTypeName());
        data.addProperty("director", vod.getDirector());
        data.addProperty("actor", vod.getActor());
        data.addProperty("content", vod.getContent());
        JsonArray flags = new JsonArray();
        for (Flag flag : vod.getFlags()) {
            JsonObject item = new JsonObject();
            item.addProperty("flag", flag.getFlag());
            JsonArray episodes = new JsonArray();
            for (Episode episode : flag.getEpisodes()) {
                JsonObject ep = new JsonObject();
                ep.addProperty("name", episode.getName());
                ep.addProperty("url", episode.getUrl());
                episodes.add(ep);
            }
            item.add("episodes", episodes);
            flags.add(item);
        }
        data.add("flags", flags);
        return data;
    }

    /**
     * 返回 {url, headers, local, hls}：local 表示地址是设备本地代理（只有本进程可达），
     * 互联网版服务端需要经设备转发（via=1），局域网版直接包装 /api/stream 即可。
     */
    public static JsonObject player(String key, String flag, String id) throws Exception {
        Result result = SiteApi.playerContent(key, TextUtils.isEmpty(flag) ? "" : flag, id);
        if (result.hasMsg()) throw new Exception(result.getMsg());
        String url = result.getUrl().v();
        Map<String, String> headers = result.getHeader();
        if (result.needParse()) {
            Map<String, String> parsed = sniff(result);
            if (parsed == null) throw new Exception("解析失败，可尝试切换线路或站点");
            url = parsed.remove(":url");
            headers = parsed;
        }
        JsonObject data = new JsonObject();
        data.addProperty("url", url);
        data.addProperty("local", isDeviceLocal(url));
        data.addProperty("hls", url.contains(".m3u8"));
        data.add("headers", App.gson().toJsonTree(headers));
        return data;
    }

    // ---------------- 直播（网页版共用） ----------------

    /**
     * 定位直播源：live 为空用当前激活源，否则按名查找（不改变 App 端的激活状态）。
     * 首次访问的源现解析频道表（LiveParser 内部有内存缓存，重复调用便宜）。
     */
    private static Live liveEntry(String live) throws Exception {
        LiveConfig.get().ensureLoaded();
        if (LiveConfig.isEmpty()) throw new IllegalStateException("直播源未配置，请先在 App 端配置直播源");
        Live item = TextUtils.isEmpty(live) ? LiveConfig.get().getHome() : LiveConfig.get().getLive(live);
        if (item.isEmpty()) throw new IllegalStateException("live source not found");
        if (item != LiveConfig.get().getHome()) LiveApi.parse(item);
        return item;
    }

    private static Channel findChannel(Live live, String group, String channel) {
        for (Group item : live.getGroups()) {
            if (item.isKeep() || !item.getName().equals(group)) continue;
            int index = item.find(channel);
            if (index != -1) return item.getChannel().get(index).group(item);
        }
        return null;
    }

    public static JsonObject liveList(String live) throws Exception {
        Live item = liveEntry(live);
        JsonObject data = new JsonObject();
        data.addProperty("name", item.getName());
        JsonArray lives = new JsonArray();
        for (Live entry : LiveConfig.get().getLives()) {
            if (entry.isEmpty()) continue;
            JsonObject element = new JsonObject();
            element.addProperty("name", entry.getName());
            element.addProperty("activated", entry.isActivated());
            lives.add(element);
        }
        data.add("lives", lives);
        boolean hasEpg = !item.getEpg().isEmpty();
        JsonArray groups = new JsonArray();
        for (Group group : item.getGroups()) {
            if (group.isKeep() || group.isHidden() || group.isEmpty()) continue;
            JsonObject element = new JsonObject();
            element.addProperty("name", group.getName());
            JsonArray channels = new JsonArray();
            for (Channel channel : group.getChannel()) {
                JsonObject node = new JsonObject();
                node.addProperty("name", channel.getName());
                node.addProperty("number", channel.getNumber());
                node.addProperty("logo", channel.getLogo());
                node.addProperty("lines", channel.getUrls().size());
                node.addProperty("epg", hasEpg || !channel.getEpg().isEmpty());
                channels.add(node);
            }
            element.add("channels", channels);
            groups.add(element);
        }
        data.add("groups", groups);
        return data;
    }

    /**
     * 返回结构同 player()：{url, headers, local, hls}，另带 flv/protocol 供前端选择播放引擎。
     */
    public static JsonObject livePlay(String live, String group, String channel, int line) throws Exception {
        Channel item = findChannel(liveEntry(live), group, channel);
        if (item == null) throw new IllegalStateException("channel not found");
        item.setIndex(line);
        Result result = LiveApi.getUrl(item);
        String url = result.getUrl().v();
        Map<String, String> headers = result.getHeader();
        if (result.needParse()) {
            Map<String, String> parsed = sniff(result);
            if (parsed == null) throw new Exception("频道解析失败，可尝试切换线路");
            url = parsed.remove(":url");
            headers = parsed;
        }
        JsonObject data = new JsonObject();
        data.addProperty("url", url);
        data.addProperty("local", isDeviceLocal(url));
        data.addProperty("hls", url.contains(".m3u8"));
        data.addProperty("flv", url.contains(".flv"));
        int index = url.indexOf("://");
        data.addProperty("protocol", index == -1 ? "http" : url.substring(0, index));
        data.add("headers", App.gson().toJsonTree(headers));
        return data;
    }

    public static JsonObject liveEpg(String live, String group, String channel) throws Exception {
        Live source = liveEntry(live);
        Channel item = findChannel(source, group, channel);
        if (item == null) throw new IllegalStateException("channel not found");
        Epg epg = LiveApi.getEpg(item, zoneOf(source));
        JsonObject data = new JsonObject();
        data.addProperty("date", epg.getDate());
        JsonArray list = new JsonArray();
        for (EpgData program : epg.getList()) {
            JsonObject node = new JsonObject();
            node.addProperty("title", program.getTitle());
            node.addProperty("start", program.getStart());
            node.addProperty("end", program.getEnd());
            node.addProperty("startTime", program.getStartTime());
            node.addProperty("endTime", program.getEndTime());
            node.addProperty("selected", program.isSelected());
            list.add(node);
        }
        data.add("list", list);
        return data;
    }

    private static ZoneId zoneOf(Live live) {
        try {
            return live.getTimeZone().isEmpty() ? ZoneId.systemDefault() : ZoneId.of(live.getTimeZone());
        } catch (Exception e) {
            return ZoneId.systemDefault();
        }
    }

    private static Site site(String key) {
        Site site = TextUtils.isEmpty(key) ? VodConfig.get().getHome() : VodConfig.get().getSite(key);
        if (site.isEmpty()) throw new IllegalStateException("site not found");
        return site;
    }

    private static boolean isDeviceLocal(String url) {
        return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") || url.startsWith(Server.get().getAddress());
    }

    /**
     * 解析类源（parse=1）：用 ParseJob 的 WebView 嗅探拿真实地址，
     * 返回的 Map 里用 ":url" 键携带地址，其余为请求头。
     */
    private static Map<String, String> sniff(Result result) throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Map<String, String>> ref = new AtomicReference<>();
        ParseJob.create(new ParseCallback() {
            @Override
            public void onParseSuccess(Map<String, String> headers, String url, String from) {
                Map<String, String> item = headers == null ? new HashMap<>() : headers;
                item.put(":url", url);
                ref.set(item);
                latch.countDown();
            }

            @Override
            public void onParseError() {
                latch.countDown();
            }
        }).start(result, false);
        latch.await(TIMEOUT_SNIFF, TimeUnit.MILLISECONDS);
        return ref.get();
    }

    private static void vodCard(JsonArray array, Site site, Vod vod) {
        JsonObject item = new JsonObject();
        item.addProperty("siteKey", site.getKey());
        item.addProperty("siteName", site.getName());
        item.addProperty("id", vod.getId());
        item.addProperty("name", vod.getName());
        item.addProperty("pic", vod.getPic());
        item.addProperty("remarks", vod.getRemarks());
        item.addProperty("typeName", vod.getTypeName());
        array.add(item);
    }
}
