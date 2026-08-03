package com.ttclab.devicelive

import android.content.Context

object AgentDiagnostics {
    private const val PREFS = "agent_diagnostics"
    private const val LAST_START_ERROR = "last_start_error"

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(LAST_START_ERROR)
            .apply()
    }

    fun record(context: Context, phase: String, error: Throwable): String {
        val cause = generateSequence(error) { it.cause }.last()
        val detail = cause.message?.takeIf(String::isNotBlank) ?: cause.javaClass.simpleName
        val message = "$phase: $detail".take(240)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(LAST_START_ERROR, message)
            .apply()
        return message
    }

    fun last(context: Context): String? = context
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(LAST_START_ERROR, null)
}
