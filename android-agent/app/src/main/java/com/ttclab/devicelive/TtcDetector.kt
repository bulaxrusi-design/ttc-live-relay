package com.ttclab.devicelive

import android.graphics.Bitmap
import android.os.SystemClock
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.io.Closeable

class TtcDetector(private val onReport: (JSONObject) -> Unit) : Closeable {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val lock = Any()
    private var profile: Profile? = null
    private var expectedPackage: String? = null
    private var ttcSessionId: String? = null
    private var generation = 0L
    private var processing = false
    private var lastOcrMonoNs = 0L
    private var stableValue: String? = null
    private var candidateValue: String? = null
    private var candidateCount = 0
    private var candidateFirstNs = 0L
    private var candidateFirstWallMs = 0L
    private var candidateFirstFrameId = 0L
    private var candidateLastFrameId = -1L
    private var startNs: Long? = null
    private var startWallMs: Long? = null
    private var startFrameId: Long? = null
    private var startLabel: String? = null
    private var actionCount = 0
    private var latest: JSONObject? = null

    fun arm(json: JSONObject, packageName: String, sessionId: String): JSONObject = synchronized(lock) {
        profile = Profile.from(json)
        expectedPackage = packageName
        ttcSessionId = sessionId
        generation += 1
        resetState()
        statusLocked().put("armed", true)
    }

    fun addActions(count: Int) = synchronized(lock) {
        actionCount += count.coerceAtLeast(0)
    }

    /** Returns true when the detector owns and will recycle frame.bitmap. */
    fun offer(frame: CapturedFrame, accessibilityText: String, foregroundPackage: String): Boolean {
        val snapshot = synchronized(lock) {
            if (expectedPackage != foregroundPackage) null else profile?.let { it to generation }
        } ?: return false
        val (current, currentGeneration) = snapshot
        if (current.mode == "manual") return false

        if (accessibilityText.isNotBlank()) {
            processText(accessibilityText, frame.frameId, frame.capturedMonoNs, frame.wallTimeMs, currentGeneration)
        }

        synchronized(lock) {
            if (processing || frame.capturedMonoNs - lastOcrMonoNs < current.ocrEveryMs * 1_000_000L) return false
            processing = true
            lastOcrMonoNs = frame.capturedMonoNs
        }
        return runCatching {
            val input = InputImage.fromBitmap(frame.bitmap, 0)
            recognizer.process(input)
                .addOnSuccessListener { result ->
                    processText(result.text, frame.frameId, frame.capturedMonoNs, frame.wallTimeMs, currentGeneration)
                }
                .addOnCompleteListener {
                    synchronized(lock) { processing = false }
                    frame.bitmap.recycle()
                }
            true
        }.getOrElse {
            synchronized(lock) { processing = false }
            false
        }
    }

    fun mark(event: String, label: String?, frameId: Long, packageName: String, sessionId: String): JSONObject = synchronized(lock) {
        val now = SystemClock.elapsedRealtimeNanos()
        val wall = System.currentTimeMillis()
        when (event) {
            "start" -> {
                profile = null
                generation += 1
                expectedPackage = packageName
                ttcSessionId = sessionId
                begin(now, wall, frameId, label ?: "manual")
            }
            "end" -> {
                require(expectedPackage == packageName) { "TTC package changed" }
                require(ttcSessionId == sessionId) { "TTC session changed" }
                require(startNs != null) { "TTC start marker is missing" }
                finish(now, wall, frameId, label ?: "manual", "explicit_marker")
            }
            else -> error("Unsupported TTC marker")
        }
        statusLocked()
    }

    fun latestReport(): JSONObject = synchronized(lock) {
        latest?.let { JSONObject(it.toString()) } ?: statusLocked()
    }

    fun status(): JSONObject = synchronized(lock) { statusLocked() }

    override fun close() {
        synchronized(lock) { generation += 1 }
        recognizer.close()
    }

    private fun processText(text: String, frameId: Long, capturedNs: Long, wallTimeMs: Long, expectedGeneration: Long) = synchronized(lock) {
        if (generation != expectedGeneration) return
        val current = profile ?: return
        when (current.mode) {
            "stage_change" -> {
                if (startNs != null && current.endRegex?.containsMatchIn(text) == true) {
                    if (confirm("__end__", frameId, capturedNs, wallTimeMs, current.stableFrames)) {
                        finish(candidateFirstNs, candidateFirstWallMs, candidateFirstFrameId, "complete", "hybrid_text_stable_${current.stableFrames}")
                        stableValue = null
                        resetCandidate()
                    }
                    return
                }
                val match = current.stageRegex?.find(text) ?: return
                val stage = match.groupValues.getOrNull(1)?.takeIf(String::isNotBlank) ?: match.value
                if (!confirm(stage, frameId, capturedNs, wallTimeMs, current.stableFrames)) return
                if (stage == stableValue) return
                val eventNs = candidateFirstNs
                val eventWall = candidateFirstWallMs
                val eventFrame = candidateFirstFrameId
                if (stableValue == null) {
                    begin(eventNs, eventWall, eventFrame, stage)
                } else {
                    finish(eventNs, eventWall, eventFrame, stage, "hybrid_text_stable_${current.stableFrames}")
                    begin(eventNs, eventWall, eventFrame, stage)
                }
                stableValue = stage
            }
            "text_end" -> {
                if (startNs == null) {
                    if (current.endRegex?.containsMatchIn(text) == true) {
                        resetCandidate()
                        return
                    }
                    val matched = current.startRegex?.containsMatchIn(text) ?: true
                    if (matched && confirm("__start__", frameId, capturedNs, wallTimeMs, current.stableFrames)) {
                        begin(candidateFirstNs, candidateFirstWallMs, candidateFirstFrameId, "start")
                        resetCandidate()
                    }
                } else if (current.endRegex?.containsMatchIn(text) == true && confirm("__end__", frameId, capturedNs, wallTimeMs, current.stableFrames)) {
                    finish(candidateFirstNs, candidateFirstWallMs, candidateFirstFrameId, "end", "hybrid_text_stable_${current.stableFrames}")
                    resetCandidate()
                }
            }
        }
    }

    private fun confirm(value: String, frameId: Long, ns: Long, wallMs: Long, needed: Int): Boolean {
        if (candidateValue != value) {
            candidateValue = value
            candidateCount = 1
            candidateFirstNs = ns
            candidateFirstWallMs = wallMs
            candidateFirstFrameId = frameId
            candidateLastFrameId = frameId
        } else if (candidateLastFrameId != frameId) {
            candidateCount += 1
            candidateLastFrameId = frameId
        }
        return candidateCount >= needed
    }

    private fun begin(ns: Long, wallMs: Long, frameId: Long, label: String) {
        startNs = ns
        startWallMs = wallMs
        startFrameId = frameId
        startLabel = label
        actionCount = 0
    }

    private fun finish(ns: Long, wallMs: Long, frameId: Long, endLabel: String, accuracy: String) {
        val start = startNs ?: return
        val current = profile
        val report = JSONObject()
            .put("type", "ttc")
            .put("ttcSessionId", ttcSessionId ?: JSONObject.NULL)
            .put("packageName", expectedPackage ?: JSONObject.NULL)
            .put("startLabel", startLabel ?: JSONObject.NULL)
            .put("endLabel", endLabel)
            .put("startMonoNs", start.toString())
            .put("endMonoNs", ns.toString())
            .put("ttcMs", (ns - start) / 1_000_000.0)
            .put("startWallTimeMs", startWallMs ?: JSONObject.NULL)
            .put("endWallTimeMs", wallMs)
            .put("startFrameId", startFrameId ?: JSONObject.NULL)
            .put("endFrameId", frameId)
            .put("actionCount", actionCount)
            .put("detectorMode", current?.mode ?: "manual")
            .put("stableFrames", current?.stableFrames ?: JSONObject.NULL)
            .put("ocrEveryMs", current?.ocrEveryMs ?: JSONObject.NULL)
            .put("accuracy", accuracy)
            .put("reportedWallTimeMs", System.currentTimeMillis())
        latest = report
        startNs = null
        startWallMs = null
        startFrameId = null
        startLabel = null
        actionCount = 0
        onReport(JSONObject(report.toString()))
    }

    private fun resetState() {
        stableValue = null
        startNs = null
        startWallMs = null
        startFrameId = null
        startLabel = null
        actionCount = 0
        latest = null
        resetCandidate()
    }

    private fun resetCandidate() {
        candidateValue = null
        candidateCount = 0
        candidateFirstNs = 0L
        candidateFirstWallMs = 0L
        candidateFirstFrameId = 0L
        candidateLastFrameId = -1L
    }

    private fun statusLocked(): JSONObject = JSONObject()
        .put("type", "ttc_status")
        .put("armed", profile != null || startNs != null)
        .put("mode", profile?.mode ?: JSONObject.NULL)
        .put("expectedPackage", expectedPackage ?: JSONObject.NULL)
        .put("ttcSessionId", ttcSessionId ?: JSONObject.NULL)
        .put("stage", stableValue ?: JSONObject.NULL)
        .put("running", startNs != null)
        .put("actionCount", actionCount)
        .put("latest", latest ?: JSONObject.NULL)

    data class Profile(
        val mode: String,
        val stageRegex: Regex?,
        val startRegex: Regex?,
        val endRegex: Regex?,
        val stableFrames: Int,
        val ocrEveryMs: Long,
    ) {
        companion object {
            fun from(json: JSONObject): Profile {
                val mode = json.optString("mode", "stage_change")
                require(mode in setOf("stage_change", "text_end", "manual")) { "Unsupported TTC mode" }
                val stage = json.optString("stageRegex").takeIf(String::isNotBlank)?.let(::Regex)
                val start = json.optString("startRegex").takeIf(String::isNotBlank)?.let(::Regex)
                val end = json.optString("endRegex").takeIf(String::isNotBlank)?.let(::Regex)
                if (mode == "stage_change") require(stage != null) { "stageRegex is required" }
                if (mode == "text_end") require(end != null) { "endRegex is required" }
                return Profile(
                    mode = mode,
                    stageRegex = stage,
                    startRegex = start,
                    endRegex = end,
                    stableFrames = json.optInt("stableFrames", 2).coerceIn(1, 5),
                    ocrEveryMs = json.optLong("ocrEveryMs", 200L).coerceIn(100L, 2000L),
                )
            }
        }
    }
}
