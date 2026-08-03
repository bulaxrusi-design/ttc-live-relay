package com.ttclab.devicelive

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.media.projection.MediaProjectionConfig
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var deviceId: EditText
    private lateinit var relayUrl: EditText
    private lateinit var token: EditText
    private lateinit var packages: EditText
    private lateinit var status: TextView

    private val captureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            toast("Screen capture permission was not granted")
            return@registerForActivityResult
        }
        val service = Intent(this, AgentService::class.java)
            .setAction(AgentService.ACTION_START)
            .putExtra(AgentService.EXTRA_RESULT_CODE, result.resultCode)
            .putExtra(AgentService.EXTRA_RESULT_DATA, data)
        ContextCompat.startForegroundService(this, service)
        toast("Live agent starting")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        deviceId = findViewById(R.id.deviceId)
        relayUrl = findViewById(R.id.relayUrl)
        token = findViewById(R.id.enrollmentToken)
        packages = findViewById(R.id.allowedPackages)
        status = findViewById(R.id.statusText)
        loadForm()

        findViewById<Button>(R.id.saveButton).setOnClickListener { saveForm(true) }
        findViewById<Button>(R.id.accessibilityButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.startButton).setOnClickListener { startAgent() }
        findViewById<Button>(R.id.stopButton).setOnClickListener {
            startService(Intent(this, AgentService::class.java).setAction(AgentService.ACTION_STOP))
        }
        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
        }
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun loadForm() {
        val config = AgentConfigStore.load(this)
        deviceId.setText(config.deviceId)
        relayUrl.setText(config.relayUrl)
        token.setText(config.enrollmentToken)
        packages.setText(config.allowedPackages.sorted().joinToString("\n"))
    }

    private fun saveForm(showToast: Boolean): Boolean = runCatching {
        val allowlist = packages.text.toString().lineSequence()
            .map(String::trim)
            .filter(String::isNotEmpty)
            .toSet()
        AgentConfigStore.save(
            this,
            AgentConfig(
                deviceId = deviceId.text.toString().trim(),
                relayUrl = relayUrl.text.toString().trim(),
                enrollmentToken = token.text.toString(),
                allowedPackages = allowlist,
            ),
        )
        if (showToast) toast("Configuration saved")
        true
    }.getOrElse {
        toast(it.message ?: "Invalid configuration")
        false
    }

    private fun startAgent() {
        if (!saveForm(false)) return
        if (Build.VERSION.SDK_INT >= 33
            && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            toast("Notification permission is required so the emergency STOP control stays visible")
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
            return
        }
        if (!GameAccessibilityService.isConnected()) {
            toast("Enable Device Lab Live accessibility service first")
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val captureIntent = if (Build.VERSION.SDK_INT >= 34) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        captureLauncher.launch(captureIntent)
    }

    private fun updateStatus() {
        val config = AgentConfigStore.load(this)
        status.text = buildString {
            appendLine("Accessibility: ${if (GameAccessibilityService.isConnected()) "connected" else "off"}")
            appendLine("Agent: ${AgentService.statusSummary()}")
            appendLine("Allowed games: ${config.allowedPackages.size}")
            appendLine("Foreground: ${GameAccessibilityService.foregroundPackage() ?: "unknown"}")
            append("Safety: gestures are rejected outside the exact local allowlist.")
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
