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
import com.fongmi.android.tv.R;
import com.fongmi.android.tv.Setting;
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
    private File cachedApk;

    public static UpdateDialog create(int versionCode, String downloadUrl) {
        UpdateDialog dialog = new UpdateDialog();
        dialog.versionCode = versionCode;
        dialog.downloadUrl = downloadUrl;
        return dialog;
    }

    public static UpdateDialog install(File apk) {
        UpdateDialog dialog = new UpdateDialog();
        dialog.cachedApk = apk;
        return dialog;
    }

    @Override
    protected ViewBinding getBinding(@NonNull LayoutInflater inflater, @Nullable ViewGroup container) {
        return mBinding = DialogUpdateBinding.inflate(inflater, container, false);
    }

    @Override
    protected void initView() {
        if (cachedApk != null) {
            showInstallReady();
        } else {
            mBinding.version.setText(getString(R.string.update_version, String.valueOf(versionCode)));
        }
    }

    @Override
    protected void initEvent() {
        mBinding.confirm.setOnClickListener(this::onConfirm);
        mBinding.cancel.setOnClickListener(v -> dismiss());
    }

    private void onConfirm(View view) {
        if (cachedApk != null) {
            installApk(cachedApk);
            return;
        }
        startDownload();
    }

    private void showInstallReady() {
        mBinding.version.setText(getString(R.string.update_version, String.valueOf(Setting.getUpdateVersion())));
        mBinding.desc.setText(R.string.update_ready);
        mBinding.desc.setVisibility(View.VISIBLE);
        mBinding.confirm.setText(R.string.update_confirm);
        mBinding.cancel.setVisibility(View.VISIBLE);
    }

    private void startDownload() {
        mBinding.cancel.setVisibility(View.GONE);
        mBinding.confirm.setEnabled(false);
        setCancelable(false);
        mBinding.desc.setVisibility(View.VISIBLE);
        mBinding.progress.setVisibility(View.VISIBLE);
        mBinding.progress.setProgress(0);
        mBinding.desc.setText(R.string.update_downloading);

        Task.submit(() -> {
            try {
                File apk = downloadApk(downloadUrl);
                Setting.putUpdateVersion(versionCode);
                Setting.putUpdateApk(apk.getAbsolutePath());
                cachedApk = apk;
                App.post(() -> {
                    setCancelable(true);
                    mBinding.cancel.setVisibility(View.VISIBLE);
                    mBinding.confirm.setEnabled(true);
                    mBinding.desc.setText(R.string.update_installing);
                    installApk(apk);
                });
            } catch (Exception e) {
                App.post(() -> {
                    mBinding.desc.setText(R.string.update_download_fail);
                    mBinding.cancel.setVisibility(View.VISIBLE);
                    mBinding.confirm.setEnabled(true);
                    setCancelable(true);
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
        File apk = new File(dir, versionCode + ".apk");

        Call call = downloadClient.newCall(request);
        try (Response response = call.execute()) {
            if (!response.isSuccessful()) throw new IOException("HTTP " + response.code());
            long contentLength = response.body().contentLength();
            try (InputStream is = response.body().byteStream();
                 FileOutputStream os = new FileOutputStream(apk)) {
                byte[] buffer = new byte[8192];
                long total = 0;
                int len;
                while ((len = is.read(buffer)) != -1) {
                    os.write(buffer, 0, len);
                    total += len;
                    if (contentLength > 0) {
                        int percent = (int) (total * 100 / contentLength);
                        App.post(() -> {
                            mBinding.progress.setProgress(percent);
                            mBinding.desc.setText(getString(R.string.update_downloading) + " " + percent + "%");
                        });
                    }
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

    @Override
    public void onDestroyView() {
        super.onDestroyView();
    }
}
