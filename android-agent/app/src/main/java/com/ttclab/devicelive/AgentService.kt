package com.ttclab.devicelive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class AgentService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var capture: CaptureEngine? = null
    private var relay: RelayClient? = null
    private var detector: TtcDetector? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val commandMutex = Mutex()
    @Volatile private var shuttingDown = false
    @Volatile private var latestFrameId = 0L

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        runCatching { CaptureEngine.realGeometry(this) }
            .onSuccess { geometry ->
                realWidth = geometry.width
                realHeight = geometry.height
            }
            .onFailure {
                // OEM window services can reject display queries from a background
                // service. Resource metrics are safe until the first frame arrives.
                realWidth = resources.displayMetrics.widthPixels.coerceAtLeast(1)
                realHeight = resources.displayMetrics.heightPixels.coerceAtLeast(1)
            }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        runCatching {
            when (intent?.action) {
                ACTION_STOP -> shutdown("stopped by user or emergency tool")
                ACTION_START -> startAgent(intent)
            }
        }.onFailure {
            failStart("service startup", it)
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shutdown("service destroyed", callStopSelf = false)
        if (instance === this) instance = null
        scope.cancel()
        super.onDestroy()
    }

    private fun startAgent(intent: Intent) {
        if (capture != null) return
        startForegroundCompat("starting")
        AgentDiagnostics.clear(this)
        val config = AgentConfigStore.load(this)
        runCatching { SafetyPolicy.validateAllowlist(config.allowedPackages) }.onFailure {
            failStart("configuration", it)
            return
        }
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE)
        val resultData: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        }
        if (resultCode == Int.MIN_VALUE || resultData == null) {
            failStart("screen capture", IllegalStateException("permission grant is missing"))
            return
        }
        detector = TtcDetector { report ->
            relay?.sendJson(JSONObject().put("type", "ttc_report").put("deviceId", config.deviceId).put("report", report))
        }
        relay = RelayClient(
            context = this,
            config = config,
            onCommand = ::handleCommand,
            onState = { next ->
                state = next
                startForegroundCompat(next)
            },
        ).also { it.connect() }
        capture = runCatching {
            CaptureEngine(
                context = this,
                resultCode = resultCode,
                resultData = resultData,
                onFrame = ::onFrame,
                onStopped = { shutdown("screen capture ended") },
            )
        }.getOrElse {
            failStart("screen capture", it)
            return
        }
        val manager = getSystemService(PowerManager::class.java)
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DeviceLabLive::capture").apply {
            setReferenceCounted(false)
            acquire(8 * 60 * 60 * 1000L)
        }
        state = "active"
        startForegroundCompat(state)
    }

    private fun failStart(phase: String, error: Throwable) {
        val detail = AgentDiagnostics.record(this, phase, error)
        runCatching { startForegroundCompat("start failed") }
        shutdown("start failed · $detail")
    }

    private fun onFrame(frame: CapturedFrame) {
        latestFrameId = frame.frameId
        realWidth = frame.displayWidth
        realHeight = frame.displayHeight
        val foreground = GameAccessibilityService.foregroundPackage()
        val text = GameAccessibilityService.accessibilityText()
        if (!SafetyPolicy.isAllowed(this, foreground)) {
            frame.bitmap.recycle()
            if (frame.frameId % 20L == 0L) relay?.sendStatus(foreground, "frame redacted: foreground is not allowlisted")
            return
        }
        val detectorOwnsBitmap = detector?.offer(frame, text, foreground!!) == true
        relay?.sendFrame(frame, foreground!!, text)
        if (!detectorOwnsBitmap) frame.bitmap.recycle()
    }

    private fun handleCommand(command: JSONObject) {
        val receivedNs = SystemClock.elapsedRealtimeNanos()
        scope.launch {
            if (command.optString("op") == "stop") processCommand(command, receivedNs)
            else commandMutex.withLock { processCommand(command, receivedNs) }
        }
    }

    private suspend fun processCommand(command: JSONObject, receivedNs: Long) {
        val id = command.optString("id")
        var stopAfterAck = false
        var dispatchNs = SystemClock.elapsedRealtimeNanos()
        val ack = JSONObject()
            .put("type", "ack")
            .put("id", id)
            .put("receivedMonoNs", receivedNs.toString())
        runCatching {
            validateFresh(command)
            val op = command.getString("op")
            dispatchNs = SystemClock.elapsedRealtimeNanos()
            ack.put("dispatchStartMonoNs", dispatchNs.toString())
            when (op) {
                    "actions" -> {
                        val expected = requireExpectedPackage(command)
                        val service = GameAccessibilityService.connectedService() ?: error("Accessibility service is disconnected")
                        val count = service.execute(command.getJSONArray("actions"), expected)
                        detector?.addActions(count)
                        ack.put("actionsCompleted", count)
                    }
                    "arm_ttc" -> {
                        val expected = requireExpectedPackage(command)
                        val ttcSessionId = command.getString("ttcSessionId")
                        ack.put("ttc", detector?.arm(command.getJSONObject("profile"), expected, ttcSessionId) ?: error("TTC detector is unavailable"))
                    }
                    "mark_ttc" -> {
                        val expected = requireExpectedPackage(command)
                        val ttcSessionId = command.getString("ttcSessionId")
                        ack.put(
                            "ttc",
                            detector?.mark(command.getString("event"), command.optString("label").takeIf(String::isNotBlank), latestFrameId, expected, ttcSessionId)
                                ?: error("TTC detector is unavailable"),
                        )
                    }
                    "get_ttc" -> {
                        val report = detector?.latestReport() ?: error("TTC detector is unavailable")
                        ack.put("ttc", report)
                        relay?.sendJson(JSONObject().put("type", "ttc_report").put("report", report))
                    }
                    "status" -> ack.put("status", statusObject())
                    "stop" -> stopAfterAck = true
                else -> error("Unsupported command")
            }
            ack.put("ok", true)
        }.onFailure {
            ack.put("ok", false).put("error", it.message ?: "command failed")
        }
        val completedNs = SystemClock.elapsedRealtimeNanos()
        ack.put("completedMonoNs", completedNs.toString())
            .put("queueDelayMs", (dispatchNs - receivedNs) / 1_000_000.0)
            .put("deviceExecutionMs", (completedNs - dispatchNs) / 1_000_000.0)
            .put("foregroundPackage", GameAccessibilityService.foregroundPackage() ?: JSONObject.NULL)
        relay?.sendJson(ack)
        if (stopAfterAck) shutdown("remote emergency stop")
    }

    private fun validateFresh(command: JSONObject) {
        val issued = command.optLong("issuedWallTimeMs", 0L)
        val ttl = command.optLong("ttlMs", 30_000L).coerceIn(1000L, 30_000L)
        if (issued > 0L) {
            val age = System.currentTimeMillis() - issued
            require(age in -5000L..(ttl + 5000L)) { "Command expired or clocks differ too much" }
        }
    }

    private fun requireExpectedPackage(command: JSONObject): String {
        val expected = command.getString("expectedPackage")
        require(SafetyPolicy.isAllowed(this, expected)) { "Package is not locally allowlisted" }
        require(GameAccessibilityService.foregroundPackage() == expected) { "Safe foreground check failed" }
        return expected
    }

    private fun statusObject(): JSONObject = JSONObject()
        .put("state", state)
        .put("frameId", latestFrameId)
        .put("foregroundPackage", GameAccessibilityService.foregroundPackage() ?: JSONObject.NULL)
        .put("accessibilityConnected", GameAccessibilityService.isConnected())
        .put("ttc", detector?.status() ?: JSONObject.NULL)

    private fun shutdown(reason: String, callStopSelf: Boolean = true) {
        if (shuttingDown) return
        shuttingDown = true
        state = reason
        capture?.close()
        capture = null
        detector?.close()
        detector = null
        relay?.sendStatus(GameAccessibilityService.foregroundPackage(), reason)
        relay?.close()
        relay = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        if (callStopSelf) stopSelf()
    }

    private fun startForegroundCompat(detail: String) {
        val stopIntent = Intent(this, AgentService::class.java).setAction(ACTION_STOP)
        val stopPending = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText("$detail · ${GameAccessibilityService.foregroundPackage() ?: "no game"}")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, getString(R.string.notification_stop), stopPending)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val ACTION_START = "com.ttclab.devicelive.START"
        const val ACTION_STOP = "com.ttclab.devicelive.STOP"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val CHANNEL_ID = "device_lab_live"
        private const val NOTIFICATION_ID = 17030

        @Volatile private var instance: AgentService? = null
        @Volatile private var state: String = "stopped"
        @Volatile private var realWidth: Int = 1
        @Volatile private var realHeight: Int = 1

        fun displayWidth(): Int = realWidth
        fun displayHeight(): Int = realHeight
        fun statusSummary(): String = state
        fun onAccessibilitySnapshot(packageName: String?, text: String, monoNs: Long) {
            // Capture frames carry the latest bounded snapshot. This callback deliberately
            // performs no network I/O and therefore cannot slow the accessibility thread.
            @Suppress("UNUSED_VARIABLE") val ignored = Triple(packageName, text, monoNs)
        }
    }
}
