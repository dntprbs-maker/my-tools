package com.woos.aiusage;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

// 앱을 열지 않아도 위젯이 스스로 사용량을 새로 조회한다(약 15분마다 + 위젯 ↻ 버튼).
// 로그인 정보는 앱과 같은 휴대폰 안 저장소(CapacitorStorage)에서 읽고, 갱신된 토큰도 거기에만 다시 쓴다.
public class UsageWorker extends Worker {
    static final String PREFS = "CapacitorStorage";
    private static final String CLAUDE_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    private static final String CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";

    public UsageWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

    static Constraints online() { return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(); }

    public static void schedule(Context context) {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(UsageWorker.class, 15, TimeUnit.MINUTES).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("usage-periodic", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    public static void refreshNow(Context context) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(UsageWorker.class).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniqueWork("usage-now", ExistingWorkPolicy.REPLACE, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONObject old = prefs.getString("widget", null) == null ? new JSONObject() : new JSONObject(prefs.getString("widget", null));
            JSONObject out = new JSONObject();
            // 한쪽이 실패해도 다른 쪽은 갱신하고, 실패한 쪽은 직전 값을 유지한다.
            out.put("claude", safe(() -> claude(prefs), old.opt("claude")));
            out.put("codex", safe(() -> codex(prefs), old.opt("codex")));
            out.put("banner", banner(out.optJSONObject("claude"), out.optJSONObject("codex")));
            SimpleDateFormat f = new SimpleDateFormat("M. d. HH:mm", Locale.KOREA);
            f.setTimeZone(TimeZone.getTimeZone("Asia/Seoul"));
            out.put("at", f.format(new Date()));
            prefs.edit().putString("widget", out.toString()).apply();
        } catch (Exception ignored) { }
        UsageWidget.doneRefreshing(ctx);
        return Result.success();
    }

    interface Call { Object run() throws Exception; }

    private static Object safe(Call c, Object fallback) {
        try { Object v = c.run(); return v == null ? JSONObject.NULL : v; }
        catch (Exception e) { return fallback == null ? JSONObject.NULL : fallback; }
    }

    // ---------- Claude ----------
    private static JSONObject claude(SharedPreferences prefs) throws Exception {
        String raw = prefs.getString("claude", null);
        if (raw == null) return null;
        JSONObject c = new JSONObject(raw);
        if (System.currentTimeMillis() > c.optLong("expires_at") - 120000) c = claudeRefresh(prefs, c);
        HttpURLConnection r = open("https://api.anthropic.com/api/oauth/usage", "GET");
        r.setRequestProperty("Authorization", "Bearer " + c.optString("access_token"));
        r.setRequestProperty("anthropic-beta", "oauth-2025-04-20");
        if (r.getResponseCode() == 401) {
            c = claudeRefresh(prefs, c);
            r = open("https://api.anthropic.com/api/oauth/usage", "GET");
            r.setRequestProperty("Authorization", "Bearer " + c.optString("access_token"));
            r.setRequestProperty("anthropic-beta", "oauth-2025-04-20");
        }
        JSONObject d = new JSONObject(body(r));
        JSONObject five = d.optJSONObject("five_hour"), week = d.optJSONObject("seven_day");
        JSONObject o = new JSONObject();
        o.put("five", five == null ? JSONObject.NULL : five.opt("utilization"));
        o.put("week", week == null ? JSONObject.NULL : week.opt("utilization"));
        o.put("fiveReset", five == null ? 0 : iso(five.optString("resets_at")));
        o.put("weekReset", week == null ? 0 : iso(week.optString("resets_at")));
        return o;
    }

    private static JSONObject claudeRefresh(SharedPreferences prefs, JSONObject c) throws Exception {
        JSONObject req = new JSONObject();
        req.put("grant_type", "refresh_token");
        req.put("refresh_token", c.optString("refresh_token"));
        req.put("client_id", CLAUDE_CLIENT);
        JSONObject d = new JSONObject(post("https://platform.claude.com/v1/oauth/token", req));
        JSONObject n = new JSONObject();
        n.put("access_token", d.getString("access_token"));
        n.put("refresh_token", d.optString("refresh_token", c.optString("refresh_token")));
        n.put("expires_at", System.currentTimeMillis() + d.optLong("expires_in", 3600) * 1000);
        prefs.edit().putString("claude", n.toString()).commit();
        return n;
    }

    // ---------- Codex ----------
    private static JSONObject codex(SharedPreferences prefs) throws Exception {
        String raw = prefs.getString("codex", null);
        if (raw == null) return null;
        JSONObject c = new JSONObject(raw);
        if (System.currentTimeMillis() > c.optLong("expires_at") - 120000) c = codexRefresh(prefs, c);
        HttpURLConnection r = codexGet(c);
        if (r.getResponseCode() == 401 || r.getResponseCode() == 403) { c = codexRefresh(prefs, c); r = codexGet(c); }
        JSONObject rl = new JSONObject(body(r)).optJSONObject("rate_limit");
        JSONObject p = rl == null ? null : rl.optJSONObject("primary_window");
        JSONObject s = rl == null ? null : rl.optJSONObject("secondary_window");
        JSONObject o = new JSONObject();
        o.put("five", p == null ? JSONObject.NULL : p.opt("used_percent"));
        o.put("week", s == null ? JSONObject.NULL : s.opt("used_percent"));
        o.put("fiveReset", p == null ? 0 : p.optLong("reset_at") * 1000);
        o.put("weekReset", s == null ? 0 : s.optLong("reset_at") * 1000);
        return o;
    }

    private static HttpURLConnection codexGet(JSONObject c) throws Exception {
        HttpURLConnection r = open("https://chatgpt.com/backend-api/wham/usage", "GET");
        r.setRequestProperty("Authorization", "Bearer " + c.optString("access_token"));
        r.setRequestProperty("ChatGPT-Account-Id", c.optString("account_id"));
        return r;
    }

    private static JSONObject codexRefresh(SharedPreferences prefs, JSONObject c) throws Exception {
        JSONObject req = new JSONObject();
        req.put("grant_type", "refresh_token");
        req.put("refresh_token", c.optString("refresh_token"));
        req.put("client_id", CODEX_CLIENT);
        req.put("scope", "openid profile email offline_access");
        JSONObject d = new JSONObject(post("https://auth.openai.com/oauth/token", req));
        JSONObject n = new JSONObject(c.toString());
        n.put("access_token", d.getString("access_token"));
        n.put("refresh_token", d.optString("refresh_token", c.optString("refresh_token")));
        n.put("expires_at", System.currentTimeMillis() + d.optLong("expires_in", 3600) * 1000);
        prefs.edit().putString("codex", n.toString()).commit();
        return n;
    }

    // ---------- 권장 문구 (앱과 같은 기준) ----------
    private static int rank(JSONObject w) {
        if (w == null || w.isNull("week") || w.optLong("weekReset") == 0) return -1;
        double cycle = 168 * 3600000.0;
        double elapsed = Math.max(0, Math.min(100, (System.currentTimeMillis() - (w.optLong("weekReset") - cycle)) / cycle * 100));
        double diff = w.optDouble("week") - elapsed;
        return diff < -10 ? 0 : diff <= 10 ? 1 : 2;
    }

    private static String banner(JSONObject a, JSONObject b) {
        int ra = rank(a), rb = rank(b);
        if (ra < 0 || rb < 0) return "AI 사용량";
        String[] emoji = { "🔵", "🟠", "🔴" };
        boolean pa = ra <= rb;
        JSONObject pri = pa ? a : b, oth = pa ? b : a;
        String pn = pa ? "코드D" : "덱스D", on = pa ? "덱스D" : "코드D";
        int pr = pa ? ra : rb, or = pa ? rb : ra;
        boolean pe = pri.optDouble("five", 0) >= 95, oe = oth.optDouble("five", 0) >= 95;
        if (pe && oe) return "⏳ 둘 다 5시간 한도가 거의 찼어요";
        if (pe) return emoji[or] + " " + on + "를 쓰세요 (" + pn + " 5시간 한도 거의 참)";
        if (oe) return emoji[pr] + " " + pn + "를 쓰세요 (" + on + " 5시간 한도 거의 참)";
        if (ra == rb) return emoji[ra] + " " + new String[] { "둘 다 열심히 사용하셔도 돼요 😄", "잘 쓰고 계시네요 👍", "그만 쓰세요 ㅋㅋ" }[ra];
        return emoji[pr] + " " + pn + "를 우선 사용하세요";
    }

    // ---------- HTTP ----------
    private static HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        return c;
    }

    private static String post(String url, JSONObject json) throws Exception {
        HttpURLConnection c = open(url, "POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = c.getOutputStream()) { os.write(json.toString().getBytes(StandardCharsets.UTF_8)); }
        return body(c);
    }

    private static String body(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            return buf.toString("UTF-8");
        }
    }

    private static long iso(String s) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US);
            return f.parse(s.replaceAll("\\.\\d+", "")).getTime();
        } catch (Exception e) { return 0; }
    }
}
