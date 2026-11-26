package com.gridlock.dashboard;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Shows the hosted Gridlock dashboard full screen.
 *
 * The models, API and database run on the server (Render + Neon), so the app
 * needs an internet connection. While the page loads — up to a minute when the
 * free server is waking up — a status panel explains the wait; if loading fails
 * it offers a retry.
 */
public class MainActivity extends Activity {

    private static final int BACKGROUND = Color.parseColor("#0d0d0d");
    private static final int TEXT = Color.parseColor("#f0efec");
    private static final int SUBTLE = Color.parseColor("#c3c2b7");

    private WebView webView;
    private LinearLayout statusPanel;
    private TextView statusTitle;
    private TextView statusDetail;
    private ProgressBar spinner;
    private Button retryButton;
    private boolean loadFailed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        webView = createWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(createStatusPanel(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            loadDashboard();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(BACKGROUND);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the theme choice is kept in localStorage
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);

        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                Uri home = Uri.parse(BuildConfig.DASHBOARD_URL);
                if (home.getHost() != null && home.getHost().equals(url.getHost())) {
                    return false; // stay inside the app for the dashboard itself
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url)); // other links open in the browser
                } catch (ActivityNotFoundException ignored) {
                    // No app can open it; ignore the tap.
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (!loadFailed) {
                    statusPanel.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError();
                }
            }
        });
        return view;
    }

    private View createStatusPanel() {
        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(32 * density);

        statusPanel = new LinearLayout(this);
        statusPanel.setOrientation(LinearLayout.VERTICAL);
        statusPanel.setGravity(Gravity.CENTER);
        statusPanel.setPadding(pad, pad, pad, pad);
        statusPanel.setBackgroundColor(BACKGROUND);
        statusPanel.setClickable(true); // block taps on the half-loaded page underneath

        spinner = new ProgressBar(this);
        statusPanel.addView(spinner);

        statusTitle = new TextView(this);
        statusTitle.setTextColor(TEXT);
        statusTitle.setTextSize(20);
        statusTitle.setGravity(Gravity.CENTER);
        statusTitle.setPadding(0, Math.round(20 * density), 0, Math.round(8 * density));
        statusPanel.addView(statusTitle);

        statusDetail = new TextView(this);
        statusDetail.setTextColor(SUBTLE);
        statusDetail.setTextSize(15);
        statusDetail.setGravity(Gravity.CENTER);
        statusPanel.addView(statusDetail);

        retryButton = new Button(this);
        retryButton.setText(R.string.retry);
        retryButton.setOnClickListener(v -> loadDashboard());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = Math.round(24 * density);
        statusPanel.addView(retryButton, params);
        return statusPanel;
    }

    private void loadDashboard() {
        loadFailed = false;
        statusTitle.setText(R.string.loading_title);
        statusDetail.setText(R.string.loading_detail);
        spinner.setVisibility(View.VISIBLE);
        retryButton.setVisibility(View.GONE);
        statusPanel.setVisibility(View.VISIBLE);
        webView.loadUrl(BuildConfig.DASHBOARD_URL);
    }

    private void showError() {
        loadFailed = true;
        statusTitle.setText(R.string.error_title);
        statusDetail.setText(R.string.error_detail);
        spinner.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        statusPanel.setVisibility(View.VISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack(); // e.g. back from the anomaly tab to the main view
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
