package com.ttclab.devicelive

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import kotlin.coroutines.resume

class GameAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
        refreshActiveWindowPackage()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val root = rootInActiveWindow
        // Status-bar and Samsung Game Tools content events can arrive while the
        // game remains the actual active window. Prefer the active root and use
        // the event package only when Android cannot provide one.
        val packageName = root?.packageName?.toString()?.takeIf(String::isNotBlank)
            ?: event?.packageName?.toString()?.takeIf(String::isNotBlank)
        if (!packageName.isNullOrBlank()) foreground = packageName
        val text = root?.let(::boundedText).orEmpty()
        latestText = text
        latestTextPackage = packageName
        AgentService.onAccessibilitySnapshot(packageName, text, SystemClock.elapsedRealtimeNanos())
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    suspend fun execute(actions: JSONArray, expectedPackage: String): Int {
        require(SafetyPolicy.isAllowed(this, expectedPackage)) { "Package is not locally allowlisted" }
        validateBatch(actions)
        var completed = 0
        for (index in 0 until actions.length()) {
            requireSafeForeground(expectedPackage)
            val action = actions.getJSONObject(index)
            when (action.getString("type")) {
                "tap" -> tap(pointX(action, "x"), pointY(action, "y"))
                "swipe" -> swipe(
                    pointX(action, "x1"),
                    pointY(action, "y1"),
                    pointX(action, "x2"),
                    pointY(action, "y2"),
                    action.optLong("durationMs", 250L).coerceIn(50L, 2000L),
                )
                "path" -> path(action.getJSONArray("points"), action.optLong("durationMs", 350L).coerceIn(50L, 3000L))
                "back" -> withContext(Dispatchers.Main.immediate) {
                    check(performGlobalAction(GLOBAL_ACTION_BACK)) { "Back gesture failed" }
                }
                "wait" -> delay(action.optLong("durationMs", 100L).coerceIn(20L, 2000L))
                else -> error("Unsupported action")
            }
            completed += 1
            val afterDefault = if (action.getString("type") == "wait") 0L else 70L
            val afterMs = action.optLong("afterMs", afterDefault).coerceIn(0L, 2000L)
            if (afterMs > 0) delay(afterMs)
        }
        return completed
    }

    private fun pointX(action: JSONObject, key: String): Float = coordinate(action, key, AgentService.displayWidth())
    private fun pointY(action: JSONObject, key: String): Float = coordinate(action, key, AgentService.displayHeight())

    private fun coordinate(action: JSONObject, key: String, extent: Int): Float {
        val raw = action.getDouble(key)
        require(extent > 0 && raw.isFinite()) { "Gesture coordinate is invalid" }
        val value = if (action.optString("space", "display") == "normalized") {
            require(raw in 0.0..1.0) { "Normalized gesture coordinate is outside display" }
            raw * (extent - 1)
        } else {
            require(raw >= 0.0 && raw < extent) { "Gesture coordinate is outside display" }
            raw
        }
        return value.toFloat()
    }

    private fun validateBatch(actions: JSONArray) {
        require(actions.length() in 1..120) { "Action batch must contain 1..120 items" }
        var budgetMs = 0L
        for (index in 0 until actions.length()) {
            val action = actions.getJSONObject(index)
            val type = action.getString("type")
            require(type in setOf("tap", "swipe", "path", "back", "wait")) { "Unsupported action" }
            val afterDefault = if (type == "wait") 0L else 70L
            val afterMs = action.optLong("afterMs", afterDefault).coerceIn(0L, 2000L)
            val activeMs = when (type) {
                "tap" -> 45L
                "swipe" -> action.optLong("durationMs", 250L).coerceIn(50L, 2000L)
                "path" -> action.optLong("durationMs", 350L).coerceIn(50L, 3000L)
                "wait" -> action.optLong("durationMs", 100L).coerceIn(20L, 2000L)
                else -> 0L
            }
            budgetMs += activeMs + afterMs
            require(budgetMs <= 30_000L) { "Action batch exceeds 30 second budget" }
        }
    }

    private suspend fun tap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        dispatch(path, 1L, 45L)
    }

    private suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        dispatch(path, 0L, durationMs)
    }

    private suspend fun path(points: JSONArray, durationMs: Long) {
        require(points.length() in 2..64) { "Gesture path size is invalid" }
        val first = points.getJSONObject(0)
        val path = Path().apply { moveTo(pointX(first, "x"), pointY(first, "y")) }
        for (index in 1 until points.length()) {
            val point = points.getJSONObject(index)
            path.lineTo(pointX(point, "x"), pointY(point, "y"))
        }
        dispatch(path, 0L, durationMs)
    }

    private suspend fun dispatch(path: Path, startMs: Long, durationMs: Long) = withContext(Dispatchers.Main.immediate) {
        suspendCancellableCoroutine { continuation ->
            val gesture = GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, startMs, durationMs))
                .build()
            val accepted = dispatchGesture(
                gesture,
                object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        if (continuation.isActive) continuation.resume(Unit)
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        if (continuation.isActive) continuation.cancel(IllegalStateException("Gesture cancelled"))
                    }
                },
                null,
            )
            if (!accepted && continuation.isActive) continuation.cancel(IllegalStateException("Gesture was not accepted"))
        }
    }

    private fun requireSafeForeground(expectedPackage: String) {
        val current = foregroundPackage()
        require(current == expectedPackage) { "Safe foreground check failed: $current" }
        require(SafetyPolicy.isAllowed(this, current)) { "Foreground package is blocked" }
    }

    private fun refreshActiveWindowPackage(): String? {
        val active = rootInActiveWindow?.packageName?.toString()?.takeIf(String::isNotBlank)
        if (active != null) foreground = active
        return active
    }

    private fun boundedText(root: AccessibilityNodeInfo): String {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val parts = LinkedHashSet<String>()
        var visited = 0
        var characters = 0
        while (queue.isNotEmpty() && visited < 600 && characters < 8000) {
            val node = queue.removeFirst()
            visited += 1
            listOf(node.text, node.contentDescription).mapNotNull { it?.toString()?.trim() }
                .filter { it.isNotEmpty() }
                .forEach {
                    if (parts.add(it)) characters += it.length + 1
                }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::addLast)
        }
        return parts.joinToString("\n").take(8000)
    }

    companion object {
        @Volatile private var instance: GameAccessibilityService? = null
        @Volatile private var foreground: String? = null
        @Volatile private var latestText: String = ""
        @Volatile private var latestTextPackage: String? = null

        fun isConnected(): Boolean = instance != null
        fun foregroundPackage(): String? {
            val active = runCatching { instance?.refreshActiveWindowPackage() }.getOrNull()
            return active ?: foreground
        }
        fun accessibilityText(): String {
            val current = foregroundPackage()
            return if (latestTextPackage == current) latestText else ""
        }
        fun connectedService(): GameAccessibilityService? = instance
    }
}
