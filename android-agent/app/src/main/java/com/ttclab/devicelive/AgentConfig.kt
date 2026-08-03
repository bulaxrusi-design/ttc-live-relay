package com.ttclab.devicelive

import android.content.Context
import java.util.UUID

data class AgentConfig(
    val deviceId: String,
    val relayUrl: String,
    val enrollmentToken: String,
    val allowedPackages: Set<String>,
)

object AgentConfigStore {
    private const val PREFS = "device_live_config"
    private const val TOKEN = "enrollment_token"

    fun load(context: Context): AgentConfig {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val generatedId = prefs.getString("device_id", null) ?: "android-${UUID.randomUUID()}"
        if (!prefs.contains("device_id")) prefs.edit().putString("device_id", generatedId).apply()
        return AgentConfig(
            deviceId = generatedId,
            relayUrl = prefs.getString("relay_url", "") ?: "",
            enrollmentToken = SecretStore(context).get(TOKEN),
            allowedPackages = prefs.getStringSet("allowed_packages", emptySet())?.toSet() ?: emptySet(),
        )
    }

    fun save(context: Context, config: AgentConfig) {
        require(config.deviceId.matches(Regex("[A-Za-z0-9._:-]{1,128}"))) { "Invalid device ID" }
        val uri = java.net.URI(config.relayUrl)
        val scheme = uri.scheme?.lowercase()
        require(scheme == "wss" || (BuildConfig.DEBUG && scheme == "ws")) {
            if (BuildConfig.DEBUG) "Relay URL must start with wss:// or ws://" else "Release builds require wss://"
        }
        require(uri.userInfo == null && uri.host != null) { "Relay URL must not contain credentials" }
        require(uri.path == "/device" && uri.query == null && uri.fragment == null) { "Relay URL must end with the exact /device path" }
        require(config.enrollmentToken.length in 32..512 && config.enrollmentToken.none(Char::isWhitespace)) {
            "Enrollment token must contain 32..512 non-space characters"
        }
        SafetyPolicy.validateAllowlist(config.allowedPackages)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("device_id", config.deviceId)
            .putString("relay_url", config.relayUrl)
            .putStringSet("allowed_packages", config.allowedPackages)
            .apply()
        SecretStore(context).put(TOKEN, config.enrollmentToken)
    }

    fun allowedPackages(context: Context): Set<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet("allowed_packages", emptySet())
            ?.toSet()
            ?: emptySet()
}
