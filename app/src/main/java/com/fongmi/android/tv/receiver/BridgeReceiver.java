package com.fongmi.android.tv.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.fongmi.android.tv.server.Bridge;

/**
 * 调试用桥接地址覆盖入口（manifest 注册，exported 便于 adb 调用）：
 * adb shell am broadcast -a com.fongmi.android.tv.BRIDGE_CONFIG --es url "http://10.0.2.2:8100/"
 * 广播里的 url 优先于设置页的 manage 地址；url 传空则清除覆盖。
 */
public class BridgeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        Bridge.get().setOverride(intent.getStringExtra("url"));
    }
}
