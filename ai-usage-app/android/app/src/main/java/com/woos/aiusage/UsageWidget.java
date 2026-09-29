package com.woos.aiusage;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

// 홈 화면 위젯: 앱이 마지막으로 조회해 저장한 값(Preferences "widget")을 보여 준다.
// 약 15분마다 UsageWorker가 새로 조회하고, ↻ 를 누르면 즉시 조회한다. 나머지 부분을 누르면 앱이 열린다.
public class UsageWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.woos.aiusage.WIDGET_REFRESH";
    private static boolean refreshing = false;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, build(context));
        UsageWorker.schedule(context);
    }

    @Override
    public void onDisabled(Context context) {
        androidx.work.WorkManager.getInstance(context).cancelUniqueWork("usage-periodic");
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            refreshing = true;
            updateAll(context);
            UsageWorker.refreshNow(context);
        }
    }

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, UsageWidget.class));
        if (ids.length > 0) manager.updateAppWidget(ids, build(context));
    }

    static void doneRefreshing(Context context) {
        refreshing = false;
        updateAll(context);
    }

    private static RemoteViews build(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.usage_widget);
        JSONObject all;
        try {
            String raw = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("widget", null);
            all = raw == null ? new JSONObject() : new JSONObject(raw);
        } catch (Exception e) {
            all = new JSONObject();
        }
        if (!all.has("banner")) {
            try { all.put("banner", "앱을 한 번 열어 조회해 주세요."); } catch (Exception ignored) { }
        }
        views.setTextViewText(R.id.widget_time, refreshing ? "조회 중…" : (all.optString("at", "").isEmpty() ? "" : all.optString("at") + " 기준"));
        try { views.setImageViewBitmap(R.id.widget_image, WidgetRenderer.draw(context, all)); } catch (Exception ignored) { }
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pi);
        Intent refresh = new Intent(context, UsageWidget.class).setAction(ACTION_REFRESH);
        PendingIntent rpi = PendingIntent.getBroadcast(context, 1, refresh, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_refresh, rpi);
        return views;
    }
}
