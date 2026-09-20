package cn.guihualab.ttydhub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private LinearLayout root;
    private WebView web;
    private TextView status;
    private ProgressBar progress;
    private SharedPreferences preferences;
    private String server = "";
    private AlertDialog loginDialog;
    private final List<HttpAuthHandler> authRequests = new ArrayList<>();
    private boolean pageFailed;
    private LoginVault loginVault;
    private SavedServers savedServers;
    private final java.util.Set<String> attemptedLogins = new java.util.HashSet<>();
    private String loginScope;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loginVault = new LoginVault(this);
        preferences = getSharedPreferences("connection", MODE_PRIVATE);
        server = preferences.getString("server", "");
        savedServers = new SavedServers(preferences.getString("servers", null), server);
        saveServerList();
        if (server.isEmpty()) showConnection(); else openServer(server);
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }
    private void setRoot(LinearLayout view) {
        root = view;
        root.setBackgroundColor(Color.rgb(15, 23, 42));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
            getWindow().setDecorFitsSystemWindows(false);
            root.requestApplyInsets();
        } else root.setFitsSystemWindows(true);
    }
    private TextView label(String text, int size) {
        TextView v = new TextView(this);
        v.setText(text); v.setTextSize(size); v.setTextColor(Color.rgb(226,232,240));
        return v;
    }
    private Button button(String text, View.OnClickListener action) {
        Button v = new Button(this); v.setText(text); v.setAllCaps(false);
        v.setMinHeight(dp(48)); v.setMinimumWidth(dp(48)); v.setOnClickListener(action);
        return v;
    }
    private EditText input(String hint, boolean password) {
        EditText v = new EditText(this); v.setHint(hint); v.setSingleLine(true);
        v.setTextSize(16);
        v.setInputType(password ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD :
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        v.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        return v;
    }
    private void destroyWeb() {
        if (loginDialog != null) { loginDialog.dismiss(); loginDialog = null; }
        for (HttpAuthHandler h : authRequests) h.cancel();
        authRequests.clear();
        loginScope = null;
        if (web != null) {
            WebView previous = web;
            web = null;
            if (previous.getParent() != null) ((android.view.ViewGroup) previous.getParent()).removeView(previous);
            previous.stopLoading(); previous.destroy();
        }
    }
    private void saveServerList() { preferences.edit().putString("servers", savedServers.encode()).apply(); }
    private void rememberConnected(String address) {
        savedServers.remember(address);
        preferences.edit().putString("servers", savedServers.encode()).putString("server", address).apply();
    }
    private void addSavedServers(LinearLayout parent, AlertDialog menu) {
        if (savedServers.entries().isEmpty()) return;
        TextView heading = label("已保存的服务器", 14);
        heading.setPadding(0, dp(20), 0, dp(8));
        parent.addView(heading);
        for (String address : savedServers.entries()) {
            LinearLayout row = new LinearLayout(this);
            row.setGravity(android.view.Gravity.CENTER_VERTICAL);
            boolean current = web != null && SavedServers.sameServer(server, address);
            Button connect = button((current ? "当前 · " : "") + address, v -> {
                if (menu != null) menu.dismiss();
                if (!current) openServer(address);
            });
            connect.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
            connect.setTextSize(14);
            if (current) connect.setTextColor(Color.rgb(96, 165, 250));
            row.addView(connect, new LinearLayout.LayoutParams(0, -2, 1));
            Button more = button("⋯", v -> {
                android.widget.PopupMenu actions = new android.widget.PopupMenu(this, v);
                actions.getMenu().add("从列表移除");
                actions.setOnMenuItemClickListener(item -> {
                    new AlertDialog.Builder(this).setTitle("移除保存的地址？")
                        .setMessage(address + "\n\n只从本机列表移除，不退出登录，也不终止服务器任务。")
                        .setPositiveButton("移除", (dialog, which) -> {
                            savedServers.remove(address); saveServerList();
                            if (SavedServers.sameServer(preferences.getString("server", ""), address))
                                preferences.edit().remove("server").apply();
                            parent.removeView(row);
                            if (savedServers.entries().isEmpty()) parent.removeView(heading);
                        }).setNegativeButton("取消", null).show();
                    return true;
                });
                actions.show();
            });
            more.setContentDescription("管理服务器 " + address);
            row.addView(more, new LinearLayout.LayoutParams(dp(48), -2));
            parent.addView(row);
        }
    }
    private void showConnection() {
        destroyWeb();
        LinearLayout outer = column(); setRoot(outer);
        LinearLayout form = column(); form.setPadding(dp(24),dp(28),dp(24),dp(16));
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.setFillViewport(true); scroll.addView(form); outer.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        form.addView(label("TTYd Hub", 30));
        TextView intro = label("把终端放进口袋\n连接你的服务器，继续电脑上的工作。", 16);
        intro.setPadding(0, dp(12), 0, dp(28)); form.addView(intro);
        EditText address = input("https://你的服务器地址", false);
        form.addView(address);
        TextView explanation = label("支持域名或 IP:端口。建议使用 HTTPS；HTTP 连接不加密。账号密码在本机加密保存，下次自动登录。", 13);
        explanation.setPadding(0,dp(12),0,dp(18)); form.addView(explanation);
        Button connect = button("连接服务器", v -> {
            try {
                String target = ServerAddress.normalize(address.getText().toString());
                ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(address.getWindowToken(),0);
                openServer(target);
            } catch (IllegalArgumentException e) { address.setError(e.getMessage()); }
        });
        form.addView(connect);
        addSavedServers(form, null);
        TextView tip = label("使用提示\n• 上下滑动历史，长按选择复制\n• 长按输入框粘贴，点击发送\n• 点击输入框调出输入法；返回键打开连接选项\n• 关闭应用不会主动终止服务器任务", 14);
        tip.setPadding(0,dp(24),0,0); form.addView(tip);
    }
    @SuppressLint("SetJavaScriptEnabled")
    private void openServer(String address) {
        destroyWeb();
        server = address;
        attemptedLogins.clear();
        LinearLayout outer = column(); setRoot(outer);
        progress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        outer.addView(progress,new LinearLayout.LayoutParams(-1,dp(3)));
        status = label("",13); status.setPadding(dp(12),dp(6),dp(12),dp(6)); status.setVisibility(View.GONE); outer.addView(status);
        web = new WebView(this); web.setBackgroundColor(Color.BLACK);
        outer.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true); // Unhandled popup windows are blocked.
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(true); settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setMinimumFontSize(1); settings.setMinimumLogicalFontSize(1);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) -> openInBrowser(url));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int value) {
                if (view != web) return;
                progress.setProgress(value); progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v,String url,android.graphics.Bitmap icon) {
                if (v != web) return;
                pageFailed = false; status.setVisibility(View.GONE);
            }
            @Override public void onPageFinished(WebView v,String url) {
                if (v != web) return;
                if (!pageFailed && ServerAddress.sameOrigin(address, url)) {
                    status.setVisibility(View.GONE);
                    rememberConnected(address);
                }
                CookieManager.getInstance().flush();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request) {
                if (v != web) return true;
                String url = request.getUrl().toString();
                if (request.isForMainFrame() && request.hasGesture() && ServerAddress.isApkDownload(url)) {
                    openInBrowser(url); return true;
                }
                if (ServerAddress.sameOrigin(address,url)) return false;
                if (request.isForMainFrame() && request.hasGesture()) openInBrowser(url);
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if ((url.startsWith("https://") || url.startsWith("http://")) && !ServerAddress.sameOrigin(address, url)) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
            @Override public void onReceivedHttpAuthRequest(WebView v,HttpAuthHandler handler,String host,String realm) {
                if (v != web || !Uri.parse(address).getHost().equalsIgnoreCase(host) || !ServerAddress.sameOrigin(address, v.getUrl())) { handler.cancel(); return; }
                String scope = ServerAddress.authScope(address, realm);
                if (attemptedLogins.add(scope)) {
                    String[] saved = loginVault.load(scope);
                    if (saved != null) { handler.proceed(saved[0], saved[1]); return; }
                } else loginVault.remove(scope);
                if (loginDialog != null && !scope.equals(loginScope)) { handler.cancel(); return; }
                loginScope = scope;
                promptLogin(handler);
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error) {
                handler.cancel();
                if (v == web) connectionError("服务器证书无法验证。请检查地址或证书后重试。");
            }
            @Override public void onReceivedError(WebView v,WebResourceRequest request,WebResourceError error) {
                if (v == web && request.isForMainFrame()) connectionError("连接失败，请检查网络和服务器地址。可在返回键菜单重试或更换服务器。");
            }
            @Override public void onReceivedHttpError(WebView v,WebResourceRequest request,WebResourceResponse response) {
                if (v == web && request.isForMainFrame() && response.getStatusCode() >= 400) connectionError("服务器返回 " + response.getStatusCode() + "，可在返回键菜单重试。");
            }
        });
        web.loadUrl(address);
    }
    private void openInBrowser(String url) {
        if (!ServerAddress.isWebUrl(url)) { notice("无法打开此下载地址"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (android.content.ActivityNotFoundException e) { notice("没有可用的浏览器，请复制链接到浏览器下载"); }
    }
    private void promptLogin(HttpAuthHandler handler) {
        authRequests.add(handler);
        if (loginDialog != null) return;
        LinearLayout form = column(); form.setPadding(dp(20),dp(8),dp(20),0);
        form.addView(label(Uri.parse(server).getAuthority(),14));
        EditText username = input("用户名",false), password = input("密码",true);
        username.setInputType(InputType.TYPE_CLASS_TEXT); form.addView(username); form.addView(password);
        loginDialog = new AlertDialog.Builder(this).setTitle("服务器登录").setView(form)
            .setPositiveButton("登录",(dialog,which)-> {
                String user = username.getText().toString(), pass = password.getText().toString();
                List<HttpAuthHandler> pending = new ArrayList<>(authRequests); authRequests.clear(); loginDialog = null;
                try { loginVault.save(loginScope, user, pass); }
                catch (Exception e) { notice("本次可登录，但无法保存密码，下次需要重新输入"); }
                for (HttpAuthHandler h : pending) h.proceed(user,pass);
                password.setText("");
            }).setNegativeButton("取消",(dialog,which)->cancelLogin()).setOnCancelListener(dialog->cancelLogin()).create();
        loginDialog.show();
    }
    private void cancelLogin() {
        for (HttpAuthHandler h : authRequests) h.cancel(); authRequests.clear(); loginDialog = null;
        connectionError("已取消登录，可在返回键菜单重新加载或更换服务器。");
    }
    private void connectionError(String text) { pageFailed = true; status.setText(text); status.setVisibility(View.VISIBLE); }
    private void notice(String message) { Toast.makeText(this,message,Toast.LENGTH_SHORT).show(); }
    private boolean canControl() { return web != null && ServerAddress.sameOrigin(server,web.getUrl()); }
    private void connectionMenu() {
        LinearLayout content = column(); content.setPadding(dp(20), 0, dp(20), dp(8));
        android.widget.ScrollView scroll = new android.widget.ScrollView(this); scroll.addView(content);
        AlertDialog menu = new AlertDialog.Builder(this).setTitle("连接选项")
            .setView(scroll).setNegativeButton("关闭", null).create();
        TextView current = label(server, 13); current.setPadding(0, dp(4), 0, dp(12)); content.addView(current);
        content.addView(button("重新加载", v -> {
            menu.dismiss();
            if (web != null) { attemptedLogins.clear(); web.reload(); }
        }));
        content.addView(button("添加服务器", v -> { menu.dismiss(); showConnection(); }));
        addSavedServers(content, menu);
        Button clear = button("清除当前服务器登录", v -> {
            new AlertDialog.Builder(this).setTitle("清除当前服务器登录？")
                .setMessage(server + "\n\n删除本机为此服务器保存的用户名和密码，其他服务器的登录保持不变。")
                .setPositiveButton("清除", (dialog, which) -> {
                    loginVault.removeServer(server);
                    android.webkit.WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
                    menu.dismiss(); showConnection(); notice("已清除当前服务器保存的登录");
                }).setNegativeButton("取消", null).show();
        });
        LinearLayout.LayoutParams clearLayout = new LinearLayout.LayoutParams(-1, -2);
        clearLayout.topMargin = dp(16); content.addView(clear, clearLayout);
        content.addView(button("返回桌面", v -> { menu.dismiss(); moveTaskToBack(true); }));
        menu.show();
    }
    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        if (!canControl()) { connectionMenu(); return; }
        web.evaluateJavascript("(()=>{const b=document.querySelector('[data-action=close-history]');if(b){b.click();return true;}return false;})()",value->{
            if (!"true".equals(value)) connectionMenu();
        });
    }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { destroyWeb(); super.onDestroy(); }
}
