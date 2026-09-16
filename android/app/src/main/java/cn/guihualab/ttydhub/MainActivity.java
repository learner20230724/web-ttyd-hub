package cn.guihualab.ttydhub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
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
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
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

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
        TextView explanation = label("支持域名或 IP:端口。建议使用 HTTPS；HTTP 连接不加密。只保存地址，登录密码不会写入本地设置。", 13);
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
        TextView tip = label("使用提示\n• 上下滑动历史，长按选择复制\n• 顶部「粘贴」可把剪贴板内容送入终端\n• 顶部「键盘」调出输入法\n• 关闭应用不会主动终止服务器任务", 14);
        tip.setPadding(0,dp(24),0,0); form.addView(tip);
    }
    @SuppressLint("SetJavaScriptEnabled")
    private void openServer(String address) {
        destroyWeb();
        LinearLayout outer = column(); setRoot(outer);
        LinearLayout toolbar = new LinearLayout(this); toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(8),0,dp(4),0);
        TextView title = label("TTYd Hub", 18);
        toolbar.addView(title,new LinearLayout.LayoutParams(0,dp(48),1)); title.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.addView(button("键盘",v->showKeyboard()));
        toolbar.addView(button("粘贴",v->pasteClipboard()));
        Button more = button("⋮",this::showMenu); more.setContentDescription("更多操作"); toolbar.addView(more);
        outer.addView(toolbar);
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
            @Override public void onReceivedHttpAuthRequest(WebView v,HttpAuthHandler handler,String host,String realm) {
                if (!Uri.parse(server).getHost().equalsIgnoreCase(host)) { handler.cancel(); return; }
                promptLogin(handler);
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error) {
                handler.cancel(); connectionError("服务器证书无法验证。请检查地址或证书后重试。");
            }
            @Override public void onReceivedError(WebView v,WebResourceRequest request,WebResourceError error) {
                if (request.isForMainFrame()) connectionError("连接失败，请检查网络和服务器地址。可在右上角重试或更换服务器。");
            }
            @Override public void onReceivedHttpError(WebView v,WebResourceRequest request,WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) connectionError("服务器返回 " + response.getStatusCode() + "，可在右上角重试。");
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
                for (HttpAuthHandler h : pending) h.proceed(user,pass);
                password.setText("");
            }).setNegativeButton("取消",(dialog,which)->cancelLogin()).setOnCancelListener(dialog->cancelLogin()).create();
        loginDialog.show();
    }
    private void cancelLogin() {
        for (HttpAuthHandler h : authRequests) h.cancel(); authRequests.clear(); loginDialog = null;
        connectionError("已取消登录，可在右上角重新加载或更换服务器。");
    }
    private void connectionError(String text) { pageFailed = true; status.setText(text); status.setVisibility(View.VISIBLE); }
    private void notice(String message) { Toast.makeText(this,message,Toast.LENGTH_SHORT).show(); }
    private boolean canControl() { return web != null && ServerAddress.sameOrigin(server,web.getUrl()); }
    private void showKeyboard() {
        if (!canControl()) return;
        web.requestFocus();
        web.evaluateJavascript("(()=>{const h=document.querySelector('.history-output');if(h){h.inputMode='text';h.focus();return true;}const t=document.querySelector('.terminal-frame')?.contentWindow?.term;if(t){t.focus();return true;}return false;})()",value->{
            if ("true".equals(value)) ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(web,InputMethodManager.SHOW_IMPLICIT);
            else notice("请先选择一个终端会话");
        });
    }
    private void pasteClipboard() {
        if (!canControl()) return;
        ClipboardManager clipboard = (ClipboardManager)getSystemService(Context.CLIPBOARD_SERVICE);
        if (!clipboard.hasPrimaryClip() || clipboard.getPrimaryClip() == null || clipboard.getPrimaryClip().getItemCount() == 0) { notice("剪贴板没有文字"); return; }
        CharSequence text = clipboard.getPrimaryClip().getItemAt(0).getText();
        if (text == null || text.length() == 0) { notice("剪贴板没有可粘贴的文字"); return; }
        String script = "(text=>{const h=document.querySelector('.history-output');if(h){const d=new DataTransfer();d.setData('text/plain',text);h.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));return true;}const t=document.querySelector('.terminal-frame')?.contentWindow?.term;if(t&&!t.options.disableStdin){t.paste(text);t.focus();return true;}return false;})(" + JSONObject.quote(text.toString()) + ")";
        web.evaluateJavascript(script,value->{ if (!"true".equals(value)) notice("请先连接并选择一个终端会话"); });
    }
    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this,anchor);
        menu.getMenu().add("重新加载"); menu.getMenu().add("更换服务器"); menu.getMenu().add("使用说明");
        menu.setOnMenuItemClickListener(item->{
            switch (item.getTitle().toString()) {
                case "重新加载": if (web != null) web.reload(); break;
                case "更换服务器": showConnection(); break;
                default: new AlertDialog.Builder(this).setTitle("手机使用说明")
                    .setMessage("在终端上上下滑动可进入历史，历史中可继续滑动和长按选择复制。\n\n点击顶部「键盘」输入，或点「粘贴」，会带着内容返回终端。不会额外发送回车。\n\n会话置顶和排序保存在本应用中，与手机浏览器分别保存。\n\n需要保持网络连接；后台恢复时如遇断线，可重新加载。服务器上的任务由 tmux 保留。")
                    .setPositiveButton("知道了",null).show();
            }
            return true;
        }); menu.show();
    }
    @Override public void onBackPressed() {
        if (!canControl()) { super.onBackPressed(); return; }
        web.evaluateJavascript("(()=>{const b=document.querySelector('[data-action=close-history]');if(b){b.click();return true;}return false;})()",value->{
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { destroyWeb(); super.onDestroy(); }
}
