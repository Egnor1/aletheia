package com.egnor.aletheia

import android.Manifest
import android.app.Activity
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.egnor.aletheia.ui.theme.AletheiaTheme
import java.io.File

class MainActivity : ComponentActivity() {
    private var webView: WebView? = null

    /** 网页里 getUserMedia 的挂起请求：等系统权限结果回来再 grant/deny */
    private val pendingMediaRequests = mutableListOf<PermissionRequest>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (!hasUsageStatsPermission()) {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
        setContent {
            AletheiaTheme {
                DaemonWebView(
                    activity = this@MainActivity,
                    url = "https://YOUR_SERVER_IP:3443/",
                    modifier = Modifier
                        .fillMaxSize()
                        .statusBarsPadding(),
                    onWebViewReady = { webView = it }
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        isInForeground = true
        webView?.evaluateJavascript("""
            (function() {
                if (!window.AletheiaBridge) { console.log('[screentime] bridge not ready'); return; }
                var data = JSON.parse(AletheiaBridge.getScreenTime());
                console.log('[screentime] sending', data.length, 'entries');
                fetch('/api/screen-time', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Auth-Token': localStorage.getItem('app_token') || ''
                    },
                    body: JSON.stringify({ data: data, timestamp: Date.now() })
                }).then(function(r) {
                    console.log('[screentime] pushed, status=' + r.status);
                }).catch(function(e) {
                    console.log('[screentime] error: ' + e);
                });
            })();
        """.trimIndent(), null)
    }

    override fun onPause() {
        super.onPause()
        isInForeground = false
        android.util.Log.i("AppLock", "MainActivity.onPause → isInForeground=false")
    }

    // ===== 网页 getUserMedia（🎙 录音 / 📷 相机）=====
    // 关键：先申请 Android 运行时权限，拿到结果再 request.grant()。
    // 只 grant 不申请系统权限时，页面拿到的 MediaStream 是空的（表现像"点了没反应"）。
    fun requestMediaPermission(request: PermissionRequest) {
        val needed = buildList {
            if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                add(Manifest.permission.CAMERA)
            }
            if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                add(Manifest.permission.RECORD_AUDIO)
            }
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            request.grant(request.resources)
            return
        }
        pendingMediaRequests.add(request)
        ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_MEDIA_PERMISSION)
    }

    fun cancelMediaPermission(request: PermissionRequest) {
        pendingMediaRequests.remove(request)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MEDIA_PERMISSION) return
        val granted = grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        val pending = pendingMediaRequests.toList()
        pendingMediaRequests.clear()
        pending.forEach { if (granted) it.grant(it.resources) else it.deny() }
    }

    private fun hasUsageStatsPermission(): Boolean {
        val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 60_000, now)
        return stats.isNotEmpty()
    }

    companion object {
        @Volatile var isInForeground = false
        private const val REQ_MEDIA_PERMISSION = 0x6d64
    }
}

@Composable
fun DaemonWebView(
    activity: MainActivity,
    url: String,
    modifier: Modifier = Modifier,
    onWebViewReady: (WebView) -> Unit = {}
) {
    val context = LocalContext.current
    // 用 MutableState 容器持有回调引用，factory lambda 捕获容器本身（稳定），不受重组影响
    val fileCallbackRef = remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val pendingCaptureUri = remember { mutableStateOf<Uri?>(null) }

    // 📄 音频 / 视频 / PDF：普通文件选择
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        fileCallbackRef.value?.onReceiveValue(uris.toTypedArray())
        fileCallbackRef.value = null
    }

    // 页面里 <input capture=environment> 的兜底：交给系统相机拍，拍完把 Uri 递回 WebView
    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { ok ->
        val cb = fileCallbackRef.value
        fileCallbackRef.value = null
        val uri = pendingCaptureUri.value
        pendingCaptureUri.value = null
        cb?.onReceiveValue(if (ok && uri != null) arrayOf(uri) else null)
    }

    // 页面里 <input capture=microphone> 的兜底：交给系统录音器录
    val recordSound = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = fileCallbackRef.value
        fileCallbackRef.value = null
        val uri = result.data?.data
        cb?.onReceiveValue(
            if (result.resultCode == Activity.RESULT_OK && uri != null) arrayOf(uri) else null
        )
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    cacheMode = WebSettings.LOAD_DEFAULT
                    // 消息气泡里的 <audio>/<video> 才不会被"需要用户手势"卡住
                    mediaPlaybackRequiresUserGesture = false
                }
                // 调试用：电脑 Chrome 打开 chrome://inspect 就能看页面 console（含 getUserMedia 报错）
                WebView.setWebContentsDebuggingEnabled(true)

                webChromeClient = object : WebChromeClient() {
                    // 🎙 / 📷：WebView 默认拒绝 getUserMedia，必须在这里放行
                    override fun onPermissionRequest(request: PermissionRequest) {
                        activity.requestMediaPermission(request)
                    }

                    override fun onPermissionRequestCanceled(request: PermissionRequest) {
                        activity.cancelMediaPermission(request)
                    }

                    override fun onShowFileChooser(
                        webView: WebView,
                        fileCallback: ValueCallback<Array<Uri>>,
                        params: FileChooserParams
                    ): Boolean {
                        // 取消上一次未完成的选择
                        fileCallbackRef.value?.onReceiveValue(null)
                        fileCallbackRef.value = fileCallback

                        val accepts = params.acceptTypes.map { it.substringBefore(';').trim() }
                        val wantsCamera = params.isCaptureEnabled && accepts.any { it.startsWith("image/") }
                        val wantsMic = params.isCaptureEnabled && accepts.any { it.startsWith("audio/") }

                        return when {
                            // 相机兜底：系统相机（这条路径不需要 CAMERA 权限，由相机 App 自己处理）
                            wantsCamera -> {
                                val dir = File(ctx.cacheDir, "captures").apply { mkdirs() }
                                val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
                                val uri = FileProvider.getUriForFile(
                                    ctx, "${ctx.packageName}.fileprovider", file
                                )
                                pendingCaptureUri.value = uri
                                takePicture.launch(uri)
                                true
                            }
                            // 录音兜底：系统录音器
                            wantsMic -> {
                                recordSound.launch(Intent(MediaStore.Audio.Media.RECORD_SOUND_ACTION))
                                true
                            }
                            // 普通选文件（📄 音频/视频/PDF、图片上传）
                            else -> {
                                val mimeTypes = accepts
                                    .filter { it.isNotBlank() }
                                    .toTypedArray()
                                    .ifEmpty { arrayOf("*/*") }
                                filePicker.launch(mimeTypes)
                                true
                            }
                        }
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun onReceivedSslError(
                        view: WebView?,
                        handler: android.webkit.SslErrorHandler?,
                        error: android.net.http.SslError?
                    ) {
                        handler?.proceed()
                    }
                }
                setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                    val filename = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
                    when {
                        url.startsWith("data:") -> {
                            val mime = url.substringAfter("data:").substringBefore(";").ifEmpty { "image/png" }
                            val b64 = url.substringAfter("base64,")
                            AletheiaBridge(ctx).saveBase64Image(b64, mime, filename)
                        }
                        !url.startsWith("blob:") -> {
                            val req = android.app.DownloadManager.Request(android.net.Uri.parse(url))
                                .setMimeType(mimeType)
                                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                                .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, filename)
                            (ctx.getSystemService(android.content.Context.DOWNLOAD_SERVICE) as android.app.DownloadManager)
                                .enqueue(req)
                        }
                        // blob: 内容 native 侧拿不到，index.html 侧应直接调 AletheiaBridge.saveBase64Image
                    }
                }
                addJavascriptInterface(AletheiaBridge(ctx), "AletheiaBridge")
                loadUrl(url)
                onWebViewReady(this)
            }
        }
    )
}
