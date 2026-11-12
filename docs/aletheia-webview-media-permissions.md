# Aletheia WebView：让 🎙 录音 / 📷 相机 真正可用

网页端（`index.html`）已经改成：麦克风只有一个按钮、走 `MediaRecorder`；相机统一先 `getUserMedia`，拿不到才退回文件选择。
**WebView 里这两样都需要 App 侧放行**，否则一律落成「选文件」。

## 要改的文件（左边是「本 web 仓库里给你准备好的副本」，右边是「你 Android 工程里的目标位置」）

| 我提供的副本（本仓库） | 复制/覆盖到你的 Android 工程 | 动作 |
|---|---|---|
| `docs/aletheia/AndroidManifest.xml` | `app/src/main/AndroidManifest.xml` | 覆盖（只多了 3 个权限 + 2 个 uses-feature + 1 个 FileProvider） |
| `docs/aletheia/MainActivity.kt` | `app/src/main/java/com/egnor/aletheia/MainActivity.kt` | 覆盖（`onResume` 的 screentime 上报、SSL proceed、DownloadListener、`AletheiaBridge` 都没动） |
| `docs/aletheia/res/xml/file_paths.xml` | **`app/src/main/res/xml/file_paths.xml`** | **新建文件**（`res/xml` 目录不存在就先建目录） |

> `res/xml/` 是你项目里已经有 Resource type = `xml` 的那个目录（`network_security_config.xml`、`backup_rules.xml`、
> `data_extraction_rules.xml` 就在里面），`file_paths.xml` 跟它们是同级、同一个文件夹。
> Manifest 里的 `android:resource="@xml/file_paths"` 就指向 `res/xml/file_paths.xml`（`@xml/` 前缀 + 文件名，不含 `.xml`）。

## 具体改了什么

### 1. 权限（AndroidManifest）

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-feature android:name="android.hardware.microphone" android:required="false" />
```

### 2. FileProvider（拍照兜底要把 Uri 递回 WebView）

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data android:name="android.support.FILE_PROVIDER_PATHS"
               android:resource="@xml/file_paths" />
</provider>
```

`app/src/main/res/xml/file_paths.xml`（新建）：

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <!-- 把 cacheDir/captures/ 暴露给 FileProvider；path 必须和 Kotlin 里
         File(cacheDir, "captures") 完全一致，否则 getUriForFile 会抛
         IllegalArgumentException: Failed to find configured root -->
    <cache-path name="captures" path="captures/" />
</paths>
```

为什么要这个文件：Android 7+ 不允许把 `file://` 路径直接交给别的 App（相机），必须走 `content://`。
`FileProvider` 就是"我的内部文件 → 借给相机 App 写"的桥，而 `file_paths.xml` 是它的**白名单**：
只有列在这里的目录才允许被 `getUriForFile()` 暴露出去。
常用标签：`<files-path>`(getFilesDir) / `<cache-path>`(getCacheDir) / `<external-files-path>` / `<external-cache-path>`。

### 3. `MainActivity.kt` 三处改动

**(a) `onPermissionRequest`（原来没有 → 所以 getUserMedia 一律被拒）**

```kotlin
webChromeClient = object : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
        activity.requestMediaPermission(request)
    }
    override fun onPermissionRequestCanceled(request: PermissionRequest) {
        activity.cancelMediaPermission(request)
    }
    // …onShowFileChooser 见 (b)
}
```

配套的 Activity 侧（**先要系统权限，再 `grant()`**；只 grant 不给系统权限时页面拿到的流是空的）：

```kotlin
fun requestMediaPermission(request: PermissionRequest) {
    val needed = buildList {
        if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) add(Manifest.permission.CAMERA)
        if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) add(Manifest.permission.RECORD_AUDIO)
    }
    val missing = needed.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isEmpty()) { request.grant(request.resources); return }
    pendingMediaRequests.add(request)
    ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_MEDIA_PERMISSION)
}

override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQ_MEDIA_PERMISSION) return
    val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
    val pending = pendingMediaRequests.toList(); pendingMediaRequests.clear()
    pending.forEach { if (granted) it.grant(it.resources) else it.deny() }
}
```

**(b) `onShowFileChooser` 尊重 `capture`**（原来是 `OpenMultipleDocuments` 一把梭 → 相机/麦克风兜底也变成文件管理器）

```kotlin
val accepts = params.acceptTypes.map { it.substringBefore(';').trim() }
val wantsCamera = params.isCaptureEnabled && accepts.any { it.startsWith("image/") }
val wantsMic    = params.isCaptureEnabled && accepts.any { it.startsWith("audio/") }
when {
    wantsCamera -> takePicture.launch(fileProviderUri)                 // 系统相机
    wantsMic    -> recordSound.launch(Intent(MediaStore.Audio.Media.RECORD_SOUND_ACTION))  // 系统录音器
    else        -> filePicker.launch(mimeTypes)                        // 📄 普通选文件，保持不变
}
```

**(c) WebView 设置**

```kotlin
settings.mediaPlaybackRequiresUserGesture = false   // 消息气泡里的 <audio>/<video> 才能直接播
WebView.setWebContentsDebuggingEnabled(true)        // chrome://inspect 看页面 console / getUserMedia 报错
```

`DaemonWebView(...)` 的签名多了一个 `activity: MainActivity` 参数（要给 `onPermissionRequest` 申请权限用），`onCreate` 里的调用已同步改好。

## 验证

1. 装新包，点 **🎙** → 弹「允许录音」→ 附件条出现「🎙 录音中 0:0X」→ 再点结束 → 音频附件 → 发送后 Daemon 能描述内容。
2. 点 **📷** → 直接出现页内相机预览 + 快门（= `getUserMedia` 通了）。
   不确定就 `chrome://inspect` 连上，在 Console 里跑：
   `navigator.mediaDevices.getUserMedia({video:true}).then(s=>console.log('ok')).catch(e=>console.log('err',e.name))`
3. 还是落文件选择？→ `webChromeClient` 没换成新版，或用户之前点过「拒绝」：去 **设置→应用→Aletheia→权限** 手动打开麦克风/相机。

## 注意

- 这份改动没有在真实工程编译验证（本机没有 Android SDK），是按你贴的 `MainActivity.kt` 原文改的；如果 `AletheiaBridge` 的构造不是 `AletheiaBridge(context)`，按你的实际签名调整即可。
- `TakePicture` 用 `cacheDir/captures`，和 `file_paths.xml` 的 `<cache-path name="captures" path="captures/">` 对应，两个都要改，否则拍照会抛 `IllegalArgumentException: Failed to find configured root`。
- 桌面浏览器不需要任何 native 改动。
