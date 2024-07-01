package com.fongmi.android.tv.utils;

import android.net.Uri;
import android.text.TextUtils;

import com.fongmi.android.tv.Setting;
import com.fongmi.android.tv.server.Server;
import com.github.catvod.utils.UriUtil;
import com.google.common.net.HttpHeaders;

import java.net.URLEncoder;

public class UrlUtil {

    public static Uri uri(String url) {
        return Uri.parse(url.trim().replace("\\", ""));
    }

    public static String scheme(String url) {
        return url == null ? "" : scheme(Uri.parse(url));
    }

    public static String scheme(Uri uri) {
        String scheme = uri.getScheme();
        return scheme == null ? "" : scheme.toLowerCase().trim();
    }

    public static String host(String url) {
        return url == null ? "" : host(Uri.parse(url));
    }

    public static String host(Uri uri) {
        String host = uri.getHost();
        return host == null ? "" : host.toLowerCase().trim();
    }

    public static String path(Uri uri) {
        String path = uri.getPath();
        return path == null ? "" : path.trim();
    }

    public static String resolve(String baseUri, String referenceUri) {
        return UriUtil.resolve(baseUri, referenceUri);
    }

    public static String convert(String url) {
        String scheme = scheme(url);
        if ("clan".equals(scheme)) return convert(fixUrl(url));
        if ("local".equals(scheme)) return url.replace("local://", Server.get().getAddress(""));
        if ("assets".equals(scheme)) return url.replace("assets://", Server.get().getAddress(""));
        if ("file".equals(scheme)) return url.replace("file://", Server.get().getAddress("file/"));
        if ("proxy".equals(scheme)) return url.replace("proxy://", Server.get().getAddress("proxy?"));
        return url;
    }

    public static String fixUrl(String url) {
        if (url.contains("/localhost/")) url = url.replace("/localhost/", "/");
        if (url.startsWith("clan")) url = url.replace("clan", "file");
        return url;
    }

    public static String fixHeader(String key) {
        if (HttpHeaders.USER_AGENT.equalsIgnoreCase(key)) return HttpHeaders.USER_AGENT;
        if (HttpHeaders.REFERER.equalsIgnoreCase(key)) return HttpHeaders.REFERER;
        if (HttpHeaders.COOKIE.equalsIgnoreCase(key)) return HttpHeaders.COOKIE;
        return key;
    }

    public static String fixDownloadUrl(String url) {
        if (TextUtils.isEmpty(url)) return "";
        Uri uri = UrlUtil.uri(url);
        boolean m3u8Ad = url.contains(".m3u8") && (Setting.isRemoveAd() || Sniffer.getRegex(uri).size() > 0);
        if (m3u8Ad) uri = Uri.parse(Server.get().getAddress(true).concat("/m3u8?url=").concat(URLEncoder.encode(url)));
        if (!uri.toString().startsWith("http://127.0.0.1:") || uri.toString().startsWith("http://127.0.0.1:9978/m3u8")) return uri.toString();
        String download = uri.getQueryParameter("url");
        return TextUtils.isEmpty(download) ? uri.toString() : download;
    }
}
