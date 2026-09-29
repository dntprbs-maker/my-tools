package com.woos.aiusage;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

// 위젯은 웹 화면을 넣을 수 없어서, 앱과 같은 모양(권장 문구 + 두 카드 + 막대)을 그림으로 그린다.
// 색·판정 기준은 앱(app.js)과 같다.
final class WidgetRenderer {
    private static final float W = 360f, PAD = 8f;
    private static final int BLUE = 0xFF1769D2, ORANGE = 0xFFF59E0B, RED = 0xFFDC2626, GREEN = 0xFF22A447;
    private static final int TEXT = 0xFF172033, MUTED = 0xFF6B778C, LINE = 0xFFDFE6EF, TRACK = 0xFFE5E7EB;

    private WidgetRenderer() { }

    static Bitmap draw(Context ctx, JSONObject all) {
        float s = Math.min(ctx.getResources().getDisplayMetrics().density, 2.5f);
        TextPaint bannerPaint = text(14, true, TEXT);
        StaticLayout banner = StaticLayout.Builder.obtain(all.optString("banner", "AI 사용량"), 0, all.optString("banner", "AI 사용량").length(), bannerPaint, (int) (W - 2 * PAD - 20))
                .setAlignment(Layout.Alignment.ALIGN_CENTER).build();
        float bannerH = banner.getHeight() + 16;
        float h = PAD + bannerH + 8 + card(all.optJSONObject("claude")) + 8 + card(all.optJSONObject("codex")) + PAD;

        Bitmap bmp = Bitmap.createBitmap((int) (W * s), (int) (h * s), Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        c.scale(s, s);

        // 권장 문구
        float y = PAD;
        RectF box = new RectF(PAD, y, W - PAD, y + bannerH);
        c.drawRoundRect(box, 12, 12, fill(0xFFEEF3FF));
        c.drawRoundRect(box, 12, 12, stroke(0xFFB8C8DC, 1));
        c.save();
        c.translate(PAD + 10, y + 8);
        banner.draw(c);
        c.restore();
        y += bannerH + 8;

        y = drawCard(c, y, "코드D (Claude)", all.optJSONObject("claude"), 0xFF7EB6FF, 0xFFEEF6FF);
        y += 8;
        drawCard(c, y, "덱스D (Codex)", all.optJSONObject("codex"), 0xFFB399FF, 0xFFF5F0FF);
        return bmp;
    }

    private static float card(JSONObject w) { return 30 + (w == null ? 36 : 2 * 50) + 4; }

    private static float drawCard(Canvas c, float y, String name, JSONObject w, int border, int headBg) {
        float h = card(w);
        RectF r = new RectF(PAD, y, W - PAD, y + h);
        c.drawRoundRect(r, 12, 12, fill(Color.WHITE));
        c.save();
        c.clipRect(PAD, y, W - PAD, y + 30);
        c.drawRoundRect(r, 12, 12, fill(headBg));
        c.restore();
        c.drawLine(PAD, y + 30, W - PAD, y + 30, stroke(LINE, 1));
        c.drawRoundRect(r, 12, 12, stroke(border, 2));
        c.drawText(name, PAD + 12, y + 21, text(15, true, TEXT));
        float ry = y + 30;
        if (w == null) {
            c.drawText("로그인이 필요합니다 — 앱을 열어 주세요", PAD + 12, ry + 24, text(13, false, MUTED));
            return y + h;
        }
        row(c, ry, "5시간", w.opt("five"), w.optLong("fiveReset"), 5);
        c.drawRect(PAD + 2, ry + 50, W - PAD - 2, ry + 53, fill(0xFFF4F7FB));
        row(c, ry + 52, "주간", w.opt("week"), w.optLong("weekReset"), 168);
        return y + h;
    }

    private static void row(Canvas c, float y, String label, Object usedObj, long reset, int hours) {
        c.drawText(label, PAD + 12, y + 22, text(14, true, TEXT));
        float bx = PAD + 58, bw = W - PAD - 76 - bx;
        if (!(usedObj instanceof Number) || reset <= 0) {
            c.drawText("값 없음", bx, y + 22, text(12, false, MUTED));
            return;
        }
        double used = clamp(((Number) usedObj).doubleValue());
        double cycle = hours * 3600000.0;
        double elapsed = clamp((System.currentTimeMillis() - (reset - cycle)) / cycle * 100);
        double diff = used - elapsed;
        int color = diff < -10 ? BLUE : diff <= 10 ? ORANGE : RED;

        c.drawRoundRect(new RectF(bx, y + 9, bx + bw, y + 19), 5, 5, fill(TRACK));
        if (used > 0) c.drawRoundRect(new RectF(bx, y + 9, bx + (float) (bw * used / 100), y + 19), 5, 5, fill(color));
        c.drawRoundRect(new RectF(bx, y + 23, bx + bw, y + 27), 2, 2, fill(TRACK));
        if (elapsed > 0) c.drawRoundRect(new RectF(bx, y + 23, bx + (float) (bw * elapsed / 100), y + 27), 2, 2, fill(GREEN));

        TextPaint pct = text(17, true, TEXT);
        pct.setTextAlign(Paint.Align.RIGHT);
        c.drawText(Math.round(used) + "%", W - PAD - 12, y + 21, pct);
        TextPaint el = text(11, false, MUTED);
        el.setTextAlign(Paint.Align.RIGHT);
        c.drawText("경과 " + Math.round(elapsed) + "%", W - PAD - 12, y + 35, el);
        c.drawText("초기화 " + dur(reset - System.currentTimeMillis()) + " · " + when(reset), bx, y + 42, text(11, false, MUTED));
    }

    private static double clamp(double v) { return Math.max(0, Math.min(100, v)); }

    private static String dur(long ms) {
        if (ms <= 0) return "0분";
        long m = (ms + 59999) / 60000, d = m / 1440;
        m %= 1440;
        long hh = m / 60, mm = m % 60;
        return (d > 0 ? d + "일 " : "") + (hh > 0 ? hh + "시간 " : "") + mm + "분";
    }

    private static String when(long t) {
        SimpleDateFormat f = new SimpleDateFormat("M. d. HH:mm", Locale.KOREA);
        f.setTimeZone(TimeZone.getTimeZone("Asia/Seoul"));
        return f.format(new Date(t));
    }

    private static TextPaint text(float size, boolean bold, int color) {
        TextPaint p = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(size);
        p.setColor(color);
        p.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        return p;
    }

    private static Paint fill(int color) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        return p;
    }

    private static Paint stroke(int color, float width) {
        Paint p = fill(color);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(width);
        return p;
    }
}
