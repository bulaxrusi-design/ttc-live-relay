package com.ttclab.devicelive

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

class RelayClient(
    private val context: Context,
    private val config: AgentConfig,
    private val onCommand: (JSONObject) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var stopped = false
    private var reconnectAttempt = 0

    fun connect() {
        if (stopped) return
        onState("connecting")
        val request = Request.Builder()
            .url(config.relayUrl)
            .header("Authorization", "Bearer ${config.enrollmentToken}")
            .build()
        socket = client.newWebSocket(request, Listener())
    }

    fun close() {
        stopped = true
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "agent stopped")
        socket = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    fun sendFrame(frame: CapturedFrame, foregroundPackage: String, accessibilityText: String) {
        val header = JSONObject()
            .put("type", "frame")
            .put("protocol", 3)
            .put("deviceId", config.deviceId)
            .put("frameId", frame.frameId)
            .put("capturedMonoNs", frame.capturedMonoNs.toString())
            .put("wallTimeMs", frame.wallTimeMs)
            .put("imageWidth", frame.imageWidth)
            .put("imageHeight", frame.imageHeight)
            .put("displayWidth", frame.displayWidth)
            .put("displayHeight", frame.displayHeight)
            .put("rotation", frame.rotation)
            .put("foregroundPackage", foregroundPackage)
            .put("contentRect", JSONObject().put("left", 0).put("top", 0).put("right", frame.imageWidth).put("bottom", frame.imageHeight))
            .put("accessibilityText", accessibilityText.take(8000))
        val metadata = header.toString().toByteArray(Charsets.UTF_8)
        val envelope = ByteBuffer.allocate(4 + metadata.size + frame.jpeg.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(metadata.size)
            .put(metadata)
            .put(frame.jpeg)
            .array()
        socket?.send(envelope.toByteString())
    }

    fun sendJson(value: JSONObject): Boolean = socket?.send(value.toString()) ?: false

    fun sendStatus(foregroundPackage: String?, detail: String) {
        sendJson(
            JSONObject()
                .put("type", "status")
                .put("deviceId", config.deviceId)
                .put("wallTimeMs", System.currentTimeMillis())
                .put("foregroundPackage", foregroundPackage ?: JSONObject.NULL)
                .put("accessibilityConnected", GameAccessibilityService.isConnected())
                .put("detail", detail),
        )
    }

    private fun hello(): JSONObject {
        val geometry = CaptureEngine.realGeometry(context)
        return JSONObject()
            .put("type", "hello")
            .put("protocol", 3)
            .put("deviceId", config.deviceId)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("display", JSONObject().put("width", geometry.width).put("height", geometry.height).put("rotation", geometry.rotation))
            .put("allowedPackages", JSONArray(config.allowedPackages.sorted()))
            .put(
                "capabilities",
                JSONArray(listOf("observe", "tap", "swipe", "path", "back", "batch", "on_device_ocr", "monotonic_ttc")),
            )
    }

    private fun reconnect() {
        if (stopped) return
        val delayMs = minOf(30_000L, 500L * (1L shl minOf(reconnectAttempt++, 6)))
        onState("reconnecting in ${delayMs}ms")
        main.postDelayed(::connect, delayMs)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            reconnectAttempt = 0
            webSocket.send(hello().toString())
            onState("connected")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching {
                require(text.length <= 128 * 1024) { "text message exceeds limit" }
                val message = JSONObject(text)
                if (message.optString("type") == "command") onCommand(message)
            }.onFailure { onState("protocol error") }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (socket !== webSocket) return
            socket = null
            reconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (socket !== webSocket) return
            socket = null
            onState("connection failed")
            reconnect()
        }
    }
}
