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
    private final java.util.Set<String> attemptedLogins = new java.util.HashSet<>();
    private String loginScope;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loginVault = new LoginVault(this);
        preferences = getSharedPreferences("connection", MODE_PRIVATE);
        server = preferences.getString("server", "");
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
        if (web != null) {
            ((android.view.ViewGroup) web.getParent()).removeView(web);
            web.stopLoading(); web.destroy(); web = null;
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
        address.setText(server); form.addView(address);
        TextView explanation = label("支持域名或 IP:端口。建议使用 HTTPS；HTTP 连接不加密。账号密码在本机加密保存，下次自动登录。", 13);
        explanation.setPadding(0,dp(12),0,dp(18)); form.addView(explanation);
        Button connect = button("连接服务器", v -> {
            try {
                server = ServerAddress.normalize(address.getText().toString());
                preferences.edit().putString("server", server).apply();
                ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(address.getWindowToken(),0);
                openServer(server);
            } catch (IllegalArgumentException e) { address.setError(e.getMessage()); }
        });
        form.addView(connect);
        TextView tip = label("使用提示\n• 上下滑动历史，长按选择复制\n• 长按输入框粘贴，点击发送\n• 点击输入框调出输入法；返回键打开连接选项\n• 关闭应用不会主动终止服务器任务", 14);
        tip.setPadding(0,dp(24),0,0); form.addView(tip);
    }
    @SuppressLint("SetJavaScriptEnabled")
    private void openServer(String address) {
        destroyWeb();
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int value) {
                progress.setProgress(value); progress.setVisibility(value == 100 ? View.GONE : View.VISIBLE);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v,String url,android.graphics.Bitmap icon) {
                pageFailed = false; status.setVisibility(View.GONE);
            }
            @Override public void onPageFinished(WebView v,String url) {
                if (!pageFailed) status.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (ServerAddress.sameOrigin(server,url)) return false;
                if (request.isForMainFrame() && request.hasGesture() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url))); }
                    catch (android.content.ActivityNotFoundException e) { notice("没有可用的浏览器"); }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if ((url.startsWith("https://") || url.startsWith("http://")) && !ServerAddress.sameOrigin(server, url)) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
            @Override public void onReceivedHttpAuthRequest(WebView v,HttpAuthHandler handler,String host,String realm) {
                if (!Uri.parse(server).getHost().equalsIgnoreCase(host) || !ServerAddress.sameOrigin(server, v.getUrl())) { handler.cancel(); return; }
                String scope = ServerAddress.authScope(server, realm);
                if (attemptedLogins.add(scope)) {
                    String[] saved = loginVault.load(scope);
                    if (saved != null) { handler.proceed(saved[0], saved[1]); return; }
                } else loginVault.remove(scope);
                if (loginDialog != null && !scope.equals(loginScope)) { handler.cancel(); return; }
                loginScope = scope;
                promptLogin(handler);
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error) {
                handler.cancel(); connectionError("服务器证书无法验证。请检查地址或证书后重试。");
            }
            @Override public void onReceivedError(WebView v,WebResourceRequest request,WebResourceError error) {
                if (request.isForMainFrame()) connectionError("连接失败，请检查网络和服务器地址。可在返回键菜单重试或更换服务器。");
            }
            @Override public void onReceivedHttpError(WebView v,WebResourceRequest request,WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) connectionError("服务器返回 " + response.getStatusCode() + "，可在返回键菜单重试。");
            }
        });
        web.loadUrl(address);
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
        new AlertDialog.Builder(this).setTitle("连接选项")
            .setItems(new String[]{"重新加载", "更换服务器", "清除已保存的登录", "返回桌面"}, (dialog, which) -> {
                if (which == 0 && web != null) { attemptedLogins.clear(); web.reload(); }
                else if (which == 1) showConnection();
                else if (which == 2) {
                    loginVault.clear();
                    android.webkit.WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
                    showConnection(); notice("已清除保存的登录信息");
                } else moveTaskToBack(true);
            }).setNegativeButton("取消", null).show();
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
