package app.kontur.messenger;

import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Небольшой мост между экраном запуска и системой Android.
 *
 * Зачем он нужен:
 *   • navigate()      — открыть мессенджер по адресу http://127.0.0.1:4000 внутри приложения,
 *                       даже если это «чужой» адрес для встроенного движка Capacitor;
 *   • startBackground() — попросить Android не выгружать сервер, когда приложение свёрнуто
 *                       (служба с постоянным уведомлением);
 *   • requestMediaPermissions() — заранее получить разрешения камеры/микрофона,
 *                       чтобы звонок начинался сразу, а не после диалогов;
 *   • openExternal()  — открыть ссылку в обычном браузере (например, страницу проекта).
 */
@CapacitorPlugin(
    name = "KonturApp",
    permissions = {
        @Permission(alias = "camera", strings = { android.Manifest.permission.CAMERA }),
        @Permission(
            alias = "microphone",
            strings = { android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.MODIFY_AUDIO_SETTINGS }
        ),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class KonturAppPlugin extends Plugin {

    /** Открыть адрес в окне приложения. */
    @PluginMethod
    public void navigate(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Не указан адрес");
            return;
        }
        getActivity().runOnUiThread(() -> {
            final WebView webView = getBridge().getWebView();
            if (webView == null) {
                call.reject("Окно приложения недоступно");
                return;
            }
            webView.loadUrl(url);
        });
        call.resolve();
    }

    /** Открыть ссылку в системном браузере. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Не указан адрес");
            return;
        }
        try {
            final Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception err) {
            call.reject("Не удалось открыть ссылку: " + err.getMessage());
        }
    }

    /** Держать сервер работающим, пока приложение в фоне. */
    @PluginMethod
    public void startBackground(PluginCall call) {
        try {
            KonturServerService.start(getContext());
            final JSObject result = new JSObject();
            result.put("running", KonturServerService.isRunning());
            call.resolve(result);
        } catch (Exception err) {
            call.reject("Не удалось включить фоновый режим: " + err.getMessage());
        }
    }

    /** Разрешить системе выгружать приложение как обычно. */
    @PluginMethod
    public void stopBackground(PluginCall call) {
        KonturServerService.stop(getContext());
        call.resolve();
    }

    /** Разрешения камеры и микрофона — заранее, одним диалогом. */
    @PluginMethod
    public void requestMediaPermissions(PluginCall call) {
        final boolean cameraOk = getPermissionState("camera").toString().equals("granted");
        final boolean micOk = getPermissionState("microphone").toString().equals("granted");
        if (cameraOk && micOk) {
            call.resolve(permissionsResult(true));
            return;
        }
        requestPermissionForAliases(new String[] { "camera", "microphone" }, call, "mediaPermissionsCallback");
    }

    @PermissionCallback
    private void mediaPermissionsCallback(PluginCall call) {
        final boolean cameraOk = getPermissionState("camera").toString().equals("granted");
        final boolean micOk = getPermissionState("microphone").toString().equals("granted");
        call.resolve(permissionsResult(cameraOk && micOk));
    }

    /** Разрешение на уведомления (для службы фоновой работы). */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (getPermissionState("notifications").toString().equals("granted")) {
            call.resolve(permissionsResult(true));
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        call.resolve(permissionsResult(getPermissionState("notifications").toString().equals("granted")));
    }

    /** Версия приложения и состояние фоновой службы. */
    @PluginMethod
    public void info(PluginCall call) {
        final JSObject data = new JSObject();
        try {
            data.put("version", getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception err) {
            data.put("version", "—");
        }
        data.put("serviceRunning", KonturServerService.isRunning());
        data.put("platform", "android");
        call.resolve(data);
    }

    private JSObject permissionsResult(boolean granted) {
        final JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("camera", getPermissionState("camera").toString());
        result.put("microphone", getPermissionState("microphone").toString());
        return result;
    }
}
