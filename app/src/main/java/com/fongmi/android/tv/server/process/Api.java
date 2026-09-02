package com.fongmi.android.tv.server.process;

import android.text.TextUtils;
import android.util.Base64;

import com.fongmi.android.tv.App;
import com.fongmi.android.tv.api.WebApi;
import com.fongmi.android.tv.server.Nano;
import com.fongmi.android.tv.server.impl.Process;
import com.github.catvod.net.OkHttp;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoHTTPD.IHTTPSession;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;

/**
 * 局域网网页观看接口（传输层）：业务逻辑在 WebApi，本类只做 HTTP 路由和视频流代理。
 * 网页由设备内置服务器直接托管（/video.html），视频流经 /api/stream 代理补齐请求头并改写 m3u8。
 */
public class Api implements Process {

    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");
    private static final OkHttpClient STREAM_CLIENT = OkHttp.client().newBuilder().readTimeout(60, TimeUnit.SECONDS).build();

    @Override
    public boolean isRequest(IHTTPSession session, String url) {
        return url.startsWith("/api/");
    }

    @Override
    public NanoHTTPD.Response doResponse(IHTTPSession session, String url, Map<String, String> files) {
        try {
            Map<String, String> params = session.getParms();
            String path = url.split("\\?")[0];
            if (path.equals("/api/sites")) return ok(WebApi.sites());
            if (path.equals("/api/home")) return ok(WebApi.home(params.get("key")));
            if (path.equals("/api/category")) return ok(WebApi.category(params.get("key"), params.get("tid"), params.get("pg")));
            if (path.equals("/api/search")) return ok(WebApi.search(params.get("key"), params.get("wd")));
            if (path.equals("/api/detail")) return ok(WebApi.detail(params.get("key"), params.get("id")));
            if (path.equals("/api/player")) return player(params);
            if (path.equals("/api/stream")) return stream(session);
            return error("unknown api");
        } catch (Exception e) {
            e.printStackTrace();
            return error(e.getMessage());
        }
    }

    private NanoHTTPD.Response player(Map<String, String> params) throws Exception {
        JsonObject data = WebApi.player(params.get("key"), params.get("flag"), params.get("id"));
        // 模拟器 NAT / 跨网段时浏览器无法直达设备地址，统一交给 /api/stream（在 app 进程内回源，本机代理地址也能访问）
        data.addProperty("play", streamUrl(data.get("url").getAsString(), encodeHeaders(headers(data))));
        return ok(data);
    }

    private NanoHTTPD.Response stream(IHTTPSession session) throws Exception {
        Map<String, String> params = session.getParms();
        String target = params.get("url");
        if (TextUtils.isEmpty(target) || !target.startsWith("http") || target.contains("/api/stream")) return error("bad url");
        Map<String, String> headers = decodeHeaders(params.get("h"));
        Request.Builder builder = new Request.Builder().url(target).get();
        for (Map.Entry<String, String> entry : headers.entrySet()) builder.header(entry.getKey(), entry.getValue());
        String range = session.getHeaders().get("range");
        if (!TextUtils.isEmpty(range)) builder.header("Range", range);
        Call call = STREAM_CLIENT.newCall(builder.build());
        okhttp3.Response res = call.execute();
        String contentType = res.header("Content-Type", "application/octet-stream");
        NanoHTTPD.Response out;
        if (target.contains(".m3u8") || contentType.contains("mpegurl")) {
            out = NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.OK, "application/vnd.apple.mpegurl", rewrite(res, params.get("h")));
        } else {
            NanoHTTPD.Response.Status status = NanoHTTPD.Response.Status.lookup(res.code());
            String length = res.header("Content-Length");
            out = TextUtils.isEmpty(length) ? NanoHTTPD.newChunkedResponse(status, contentType, res.body().byteStream()) : NanoHTTPD.newFixedLengthResponse(status, contentType, res.body().byteStream(), Long.parseLong(length));
            copyHeader(res, out, "Content-Range");
            copyHeader(res, out, "Accept-Ranges");
        }
        return cors(out);
    }

    /**
     * 把 m3u8 里的分片/密钥地址改写成本代理的绝对路径，使浏览器拉流仍带上源站要求的请求头。
     */
    private String rewrite(okhttp3.Response res, String headerParam) throws Exception {
        StringBuilder sb = new StringBuilder();
        HttpUrl base = res.request().url();
        BufferedReader reader = new BufferedReader(new InputStreamReader(res.body().byteStream(), StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.startsWith("#")) {
                Matcher matcher = URI_ATTR.matcher(line);
                StringBuffer buf = new StringBuffer();
                while (matcher.find()) {
                    HttpUrl abs = base.resolve(matcher.group(1));
                    matcher.appendReplacement(buf, Matcher.quoteReplacement("URI=\"" + (abs == null ? matcher.group(1) : streamUrl(abs.toString(), headerParam)) + "\""));
                }
                matcher.appendTail(buf);
                sb.append(buf);
            } else if (!line.trim().isEmpty()) {
                HttpUrl abs = base.resolve(line.trim());
                sb.append(abs == null ? line.trim() : streamUrl(abs.toString(), headerParam));
            }
            sb.append('\n');
        }
        reader.close();
        return sb.toString();
    }

    /**
     * headerParam 是入口请求里已 URL 编码过的 h 参数，分片与密钥沿用同一份请求头（UA/Referer 等），
     * 避免每次分片请求被源站拒绝。
     */
    private String streamUrl(String url, String encodedHeaderParam) {
        try {
            StringBuilder sb = new StringBuilder("/api/stream?url=").append(URLEncoder.encode(url, "UTF-8"));
            if (!TextUtils.isEmpty(encodedHeaderParam)) sb.append("&h=").append(encodedHeaderParam);
            return sb.toString();
        } catch (Exception e) {
            return url;
        }
    }

    private Map<String, String> headers(JsonObject data) {
        Map<String, String> headers = new HashMap<>();
        for (Map.Entry<String, JsonElement> entry : data.getAsJsonObject("headers").entrySet()) headers.put(entry.getKey(), entry.getValue().getAsString());
        return headers;
    }

    private String encodeHeaders(Map<String, String> headers) {
        return Base64.encodeToString(App.gson().toJson(headers).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private Map<String, String> decodeHeaders(String text) {
        Map<String, String> headers = new HashMap<>();
        if (TextUtils.isEmpty(text)) return headers;
        try {
            JsonObject object = App.gson().fromJson(new String(Base64.decode(text, Base64.DEFAULT), StandardCharsets.UTF_8), JsonObject.class);
            for (Map.Entry<String, JsonElement> entry : object.entrySet()) headers.put(entry.getKey(), entry.getValue().getAsString());
        } catch (Exception e) {
            e.printStackTrace();
        }
        return headers;
    }

    private void copyHeader(okhttp3.Response res, NanoHTTPD.Response out, String name) {
        String value = res.header(name);
        if (!TextUtils.isEmpty(value)) out.addHeader(name, value);
    }

    private NanoHTTPD.Response ok(JsonObject data) {
        return cors(NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.OK, "application/json", data.toString()));
    }

    private NanoHTTPD.Response error(String msg) {
        JsonObject data = new JsonObject();
        data.addProperty("error", TextUtils.isEmpty(msg) ? "error" : msg);
        return cors(NanoHTTPD.newFixedLengthResponse(NanoHTTPD.Response.Status.OK, "application/json", data.toString()));
    }

    private NanoHTTPD.Response cors(NanoHTTPD.Response response) {
        response.addHeader("Access-Control-Allow-Origin", "*");
        return response;
    }
}
