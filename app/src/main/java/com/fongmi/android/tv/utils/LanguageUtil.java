package com.fongmi.android.tv.utils;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Resources;

import java.util.Locale;

public class LanguageUtil {
    public static void setLanguage(Resources resources, int lang) {
        resources.getConfiguration().locale = getLocaleByLanguage(lang);
        resources.updateConfiguration(resources.getConfiguration(), resources.getDisplayMetrics());
    }

    private static Locale getLocaleByLanguage(int lang) {
        if (lang == 0) return Locale.ENGLISH;
        else if (lang == 1) return Locale.CHINESE;
        else if (lang == 2) return Locale.TRADITIONAL_CHINESE;
        else return Locale.ENGLISH;
    }

    public static void restartApp(Activity activity) {
        Intent intent = activity.getBaseContext().getPackageManager().getLaunchIntentForPackage(activity.getBaseContext().getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        activity.startActivity(intent);
    }
}
