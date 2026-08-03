package com.ttclab.devicelive

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Surface
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

data class CapturedFrame(
    val bitmap: Bitmap,
    val jpeg: ByteArray,
    val frameId: Long,
    val capturedMonoNs: Long,
    val wallTimeMs: Long,
    val imageWidth: Int,
    val imageHeight: Int,
    val displayWidth: Int,
    val displayHeight: Int,
    val rotation: Int,
)

class CaptureEngine(
    private val context: Context,
    resultCode: Int,
    resultData: Intent,
    private val onFrame: (CapturedFrame) -> Unit,
    private val onStopped: () -> Unit,
) {
    private val thread = HandlerThread("device-live-capture").apply { start() }
    private val handler = Handler(thread.looper)
    private var geometry = realGeometry(context)
    private val projection: MediaProjection
    private var reader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var nextFrameId = 0L
    private var lastCaptureNs = 0L
    @Volatile private var closed = false

    init {
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        projection = requireNotNull(manager.getMediaProjection(resultCode, resultData))
        projection.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                close(false)
                onStopped()
            }

            override fun onCapturedContentResize(width: Int, height: Int) {
                if (width <= 0 || height <= 0 || closed) return
                val display = realGeometry(context)
                val next = Geometry(width, height, display.densityDpi, display.rotation)
                if (virtualDisplay == null) {
                    geometry = next
                    return
                }
                if (next != geometry) reconfigure(next)
            }
        }, handler)
        val initialReader = createReader(geometry)
        reader = initialReader
        try {
            virtualDisplay = requireNotNull(projection.createVirtualDisplay(
                "DeviceLabLive",
                geometry.width,
                geometry.height,
                geometry.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                initialReader.surface,
                null,
                handler,
            ))
        } catch (error: Throwable) {
            reader = null
            initialReader.setOnImageAvailableListener(null, null)
            initialReader.close()
            runCatching { projection.stop() }
            thread.quitSafely()
            throw error
        }
    }

    fun close(stopProjection: Boolean = true) = close(stopProjection, true)

    private fun close(stopProjection: Boolean, stopThread: Boolean) {
        if (closed) return
        closed = true
        reader?.let { runCatching { it.setOnImageAvailableListener(null, null) } }
        virtualDisplay?.let { runCatching { it.release() } }
        reader?.let { runCatching { it.close() } }
        reader = null
        virtualDisplay = null
        if (stopProjection) runCatching { projection.stop() }
        if (stopThread) thread.quitSafely()
    }

    private fun acquire(source: ImageReader) {
        val image = source.acquireLatestImage() ?: return
        if (closed || source !== reader) {
            image.close()
            return
        }
        val currentGeometry = realGeometry(context)
        if (currentGeometry.width != geometry.width
            || currentGeometry.height != geometry.height
            || currentGeometry.densityDpi != geometry.densityDpi
        ) {
            image.close()
            reconfigure(currentGeometry)
            return
        }
        geometry = currentGeometry
        val now = SystemClock.elapsedRealtimeNanos()
        if (now - lastCaptureNs < FRAME_PERIOD_NS) {
            image.close()
            return
        }
        lastCaptureNs = now
        try {
            val frameGeometry = geometry
            val full = imageToBitmap(image)
            val targetWidth = minOf(MAX_FRAME_WIDTH, full.width)
            val targetHeight = (full.height.toDouble() * targetWidth / full.width).roundToInt().coerceAtLeast(1)
            val scaled = if (targetWidth == full.width) full else Bitmap.createScaledBitmap(full, targetWidth, targetHeight, true).also { full.recycle() }
            val jpeg = ByteArrayOutputStream().use { output ->
                check(scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output))
                output.toByteArray()
            }
            onFrame(
                CapturedFrame(
                    bitmap = scaled,
                    jpeg = jpeg,
                    frameId = ++nextFrameId,
                    capturedMonoNs = now,
                    wallTimeMs = System.currentTimeMillis(),
                    imageWidth = scaled.width,
                    imageHeight = scaled.height,
                    displayWidth = frameGeometry.width,
                    displayHeight = frameGeometry.height,
                    rotation = frameGeometry.rotation,
                ),
            )
        } catch (_: Throwable) {
            // The service publishes capture errors through its status message.
        } finally {
            image.close()
        }
    }

    private fun createReader(value: Geometry): ImageReader = ImageReader.newInstance(
        value.width,
        value.height,
        PixelFormat.RGBA_8888,
        2,
    ).also { it.setOnImageAvailableListener({ source -> acquire(source) }, handler) }

    private fun reconfigure(next: Geometry) {
        if (closed) return
        val oldReader = reader ?: return
        val display = virtualDisplay ?: return
        val replacement = createReader(next)
        runCatching {
            display.resize(next.width, next.height, next.densityDpi)
            display.surface = replacement.surface
        }.onFailure {
            replacement.setOnImageAvailableListener(null, null)
            replacement.close()
            return
        }
        geometry = next
        reader = replacement
        oldReader.setOnImageAvailableListener(null, null)
        oldReader.close()
    }

    private fun imageToBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val paddedWidth = rowStride / pixelStride
        val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
        plane.buffer.rewind()
        padded.copyPixelsFromBuffer(plane.buffer)
        if (paddedWidth == image.width) return padded
        return Bitmap.createBitmap(padded, 0, 0, image.width, image.height).also { padded.recycle() }
    }

    data class Geometry(val width: Int, val height: Int, val densityDpi: Int, val rotation: Int)

    companion object {
        private const val MAX_FRAME_WIDTH = 720
        private const val JPEG_QUALITY = 68
        private const val FRAME_PERIOD_NS = 100_000_000L

        fun realGeometry(context: Context): Geometry {
            val windowManager = context.getSystemService(WindowManager::class.java)
            val metrics = DisplayMetrics()
            val width: Int
            val height: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val bounds = windowManager.maximumWindowMetrics.bounds
                width = bounds.width()
                height = bounds.height()
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay.getRealMetrics(metrics)
                width = metrics.widthPixels
                height = metrics.heightPixels
            }
            val density = context.resources.configuration.densityDpi
            val rotation = if (Build.VERSION.SDK_INT >= 30) {
                context.display?.rotation ?: Surface.ROTATION_0
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay.rotation
            }
            return Geometry(width, height, density, rotation)
        }
    }
}
