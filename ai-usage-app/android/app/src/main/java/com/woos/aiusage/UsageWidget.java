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
// 누르면 앱이 열리고, 앱이 새로 조회한 뒤 나갈 때 위젯이 갱신된다.
public class UsageWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, build(context));
    }

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, UsageWidget.class));
        if (ids.length > 0) manager.updateAppWidget(ids, build(context));
    }

    private static String line(JSONObject all, String key, String name) {
        JSONObject w = all.optJSONObject(key);
        if (w == null) return name + "  로그인 필요";
        return name + "  5시간 " + pct(w, "five") + "  ·  주간 " + pct(w, "week");
    }

    private static String pct(JSONObject w, String key) {
        return w.isNull(key) ? "-" : Math.round(w.optDouble(key)) + "%";
    }

    private static RemoteViews build(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.usage_widget);
        String text;
        try {
            String raw = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("widget", null);
            if (raw == null) throw new Exception("empty");
            JSONObject all = new JSONObject(raw);
            text = line(all, "claude", "코드D") + "\n" + line(all, "codex", "덱스D") + "\n" + all.optString("at", "") + " 기준 · 눌러서 새로고침";
            views.setTextViewText(R.id.widget_banner, all.optString("banner", "AI 사용량"));
        } catch (Exception e) {
            text = "앱을 한 번 열어 조회해 주세요.";
            views.setTextViewText(R.id.widget_banner, "AI 사용량");
        }
        views.setTextViewText(R.id.widget_text, text);
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pi);
        return views;
    }
}
