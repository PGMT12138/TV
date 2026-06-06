package com.fongmi.android.tv.ui.dialog;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.viewbinding.ViewBinding;

import com.fongmi.android.tv.App;
import com.fongmi.android.tv.BuildConfig;
import com.fongmi.android.tv.R;
import com.fongmi.android.tv.databinding.DialogUpdateBinding;
import com.fongmi.android.tv.utils.FileUtil;
import com.fongmi.android.tv.utils.Task;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Path;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class UpdateDialog extends BaseDialog {

    private DialogUpdateBinding mBinding;
    private int versionCode;
    private String downloadUrl;
    private File downloadedApk;

    public static UpdateDialog create(int versionCode, String downloadUrl) {
        UpdateDialog dialog = new UpdateDialog();
        dialog.versionCode = versionCode;
        dialog.downloadUrl = downloadUrl;
        return dialog;
    }

    @Override
    protected ViewBinding getBinding(@NonNull LayoutInflater inflater, @Nullable ViewGroup container) {
        return mBinding = DialogUpdateBinding.inflate(inflater, container, false);
    }

    @Override
    protected void initView() {
        mBinding.version.setText(getString(R.string.update_version, String.valueOf(versionCode)));
        mBinding.desc.setText(R.string.update_downloading);
    }

    @Override
    protected void initEvent() {
        mBinding.confirm.setOnClickListener(this::onConfirm);
        mBinding.cancel.setOnClickListener(v -> dismiss());
    }

    private void onConfirm(View view) {
        mBinding.confirm.setEnabled(false);
        mBinding.cancel.setEnabled(false);
        mBinding.desc.setText(R.string.update_downloading);
        Task.submit(() -> {
            try {
                downloadedApk = downloadApk(downloadUrl);
                App.post(() -> {
                    dismiss();
                    installApk(downloadedApk);
                });
            } catch (Exception e) {
                App.post(() -> {
                    mBinding.desc.setText(R.string.update_download_fail);
                    mBinding.confirm.setEnabled(true);
                    mBinding.cancel.setEnabled(true);
                });
            }
        });
    }

    private File downloadApk(String url) throws IOException {
        OkHttpClient downloadClient = OkHttp.client().newBuilder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.MINUTES)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build();

        Request request = new Request.Builder().url(url).build();
        File dir = new File(Path.cache(), "update");
        dir.mkdirs();
        File apk = new File(dir, "latest.apk");

        try (Response response = downloadClient.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("HTTP " + response.code());
            try (InputStream is = response.body().byteStream();
                 FileOutputStream os = new FileOutputStream(apk)) {
                byte[] buffer = new byte[8192];
                int len;
                while ((len = is.read(buffer)) != -1) {
                    os.write(buffer, 0, len);
                }
            }
        }
        return apk;
    }

    private void installApk(File apk) {
        Activity activity = getActivity();
        if (activity == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Uri uri = FileUtil.getShareUri(apk);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        activity.startActivity(intent);
    }
}
