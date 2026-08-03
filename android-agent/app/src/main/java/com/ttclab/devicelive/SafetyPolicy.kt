package com.ttclab.devicelive

import android.content.Context

object SafetyPolicy {
    private val packagePattern = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")
    private val hardBlocked = setOf(
        "android",
        "com.android.systemui",
        "com.android.settings",
        "com.android.permissioncontroller",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.google.android.permissioncontroller",
        "com.android.vending",
        "com.google.android.gms",
        "com.google.android.gms.authenticator",
        "com.google.android.apps.walletnfcrel",
        "com.samsung.android.app.spage",
        "com.samsung.android.packageinstaller",
        "com.samsung.android.spay",
        "com.samsung.android.spayfw",
    )
    private val sensitiveTokens = listOf("bank", "wallet", "payment", "billing", "authenticator", "installer")

    fun validateAllowlist(packages: Set<String>) {
        require(packages.isNotEmpty()) { "Add at least one exact game package" }
        require(packages.size <= 100) { "At most 100 game packages are allowed" }
        for (packageName in packages) {
            require(packageName.matches(packagePattern)) { "Invalid package: $packageName" }
            require(!isHardBlocked(packageName)) { "Sensitive/system package is blocked: $packageName" }
        }
    }

    fun isAllowed(context: Context, packageName: String?): Boolean {
        if (packageName.isNullOrBlank() || isHardBlocked(packageName)) return false
        return AgentConfigStore.allowedPackages(context).contains(packageName)
    }

    fun isHardBlocked(packageName: String): Boolean {
        val lower = packageName.lowercase()
        return packageName in hardBlocked || sensitiveTokens.any(lower::contains)
    }
}
