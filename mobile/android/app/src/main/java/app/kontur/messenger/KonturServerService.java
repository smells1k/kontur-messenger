package app.kontur.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Служба «сервер работает».
 *
 * Android охотно выгружает приложения из памяти, когда экран погашен. Пока эта служба
 * запущена, система держит процесс приложения (а вместе с ним и Node.js-сервер) живым —
 * друзья могут писать вам, даже если мессенджер свёрнут. Работает с постоянным
 * уведомлением, которое можно использовать и для быстрого возврата в приложение.
 */
public class KonturServerService extends Service {

    private static final String CHANNEL_ID = "kontur-server";
    private static final int NOTIFICATION_ID = 4000;
    private static volatile boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    public static void start(Context context) {
        final Intent intent = new Intent(context, KonturServerService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        running = false;
        context.stopService(new Intent(context, KonturServerService.class));
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        final Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;
        // Если система всё же убьёт процесс — пусть попробует поднять его снова
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        final NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        final NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Сервер мессенджера",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Работа сервера «Контура», пока приложение свёрнуто");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        final Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        final PendingIntent openPending = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        final Intent stopIntent = new Intent(this, KonturServerService.class);
        stopIntent.setAction("app.kontur.messenger.STOP");
        final PendingIntent stopPending = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Контур работает")
            .setContentText("Сервер мессенджера запущен — друзья могут подключаться")
            .setSmallIcon(R.drawable.ic_kontur_notify)
            .setContentIntent(openPending)
            .addAction(0, "Остановить", stopPending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }
}
