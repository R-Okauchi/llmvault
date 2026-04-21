package io.llmvault.mobile

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.biometric.BiometricPrompt.AuthenticationCallback
import androidx.biometric.BiometricPrompt.AuthenticationResult
import androidx.biometric.BiometricPrompt.PromptInfo
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Date
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Manages biometric authentication for key access.
 *
 * The master key in SecureKeyStore is configured as a time-bound Keystore
 * key (see SecureKeyStore.ensureMasterKeyExists and the 300-second validity
 * window). After a successful BiometricPrompt the Android Keystore
 * authorises Cipher operations on that key from any thread for the
 * validity window; outside the window the Keystore throws
 * UserNotAuthenticatedException. Because the key is not per-use, we do NOT
 * wrap the Cipher in a BiometricPrompt.CryptoObject — time-bound keys
 * reject CryptoObject-bound authentication at init().
 *
 * This manager therefore focuses on two jobs:
 *   1. Run BiometricPrompt with no CryptoObject and record the last
 *      successful auth timestamp.
 *   2. Provide an app-layer fast-path ([needsAuth]) that skips the UI
 *      prompt when the caller is still within the policy auto-approve
 *      window. The OS-enforced Keystore window is the backstop — even if
 *      the app-layer timer drifts, the Keystore refuses decryption after
 *      its own validity window expires.
 */
class BiometricAuthManager {

    /** Tracks the timestamp of the last successful biometric authentication. */
    private var lastAuthAt: Date? = null

    // -------------------------------------------------------------------------
    // Availability
    // -------------------------------------------------------------------------

    /**
     * Describes biometric hardware availability on this device.
     * Mirrors iOS BiometricAuth.Availability.
     */
    data class Availability(
        val available: Boolean,
        val biometryType: String,
    )

    /**
     * Check whether strong biometrics are available on this device.
     */
    fun checkAvailability(context: Context): Availability {
        val manager = BiometricManager.from(context)
        val result = manager.canAuthenticate(BIOMETRIC_STRONG)
        val available = result == BiometricManager.BIOMETRIC_SUCCESS

        val biometryType = when {
            !available -> "none"
            context.packageManager.hasSystemFeature("android.hardware.biometrics.face") -> "faceId"
            context.packageManager.hasSystemFeature("android.hardware.fingerprint") -> "fingerprint"
            else -> "biometric"
        }

        return Availability(available = available, biometryType = biometryType)
    }

    // -------------------------------------------------------------------------
    // Suspend-based authentication — used from coroutine contexts
    // -------------------------------------------------------------------------

    /**
     * Show a BiometricPrompt and suspend until the user authenticates or cancels.
     *
     * No CryptoObject is attached; the Android Keystore-managed validity
     * window is used for subsequent Cipher operations.
     *
     * Throws [BiometricAuthException] on failure or cancellation.
     */
    suspend fun authenticate(
        activity: FragmentActivity,
        reason: String,
    ): AuthenticationResult = suspendCancellableCoroutine { cont ->

        val executor = ContextCompat.getMainExecutor(activity)

        val callback = object : AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: AuthenticationResult) {
                lastAuthAt = Date()
                if (cont.isActive) cont.resume(result)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (cont.isActive) {
                    cont.resumeWithException(
                        BiometricAuthException(errorCode, errString.toString()),
                    )
                }
            }

            override fun onAuthenticationFailed() {
                // Individual attempt failed; BiometricPrompt retries automatically.
                // Do not cancel the coroutine here.
            }
        }

        val prompt = BiometricPrompt(activity, executor, callback)

        val promptInfo = PromptInfo.Builder()
            .setTitle(LlmvaultMobileConfig.biometricPromptTitle)
            .setSubtitle(reason)
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()

        prompt.authenticate(promptInfo)

        cont.invokeOnCancellation {
            prompt.cancelAuthentication()
        }
    }

    // -------------------------------------------------------------------------
    // Auto-approve window helpers
    // -------------------------------------------------------------------------

    /**
     * Returns true if biometric authentication is required (outside the window).
     * Returns false if within [autoApproveSeconds] of the last successful auth.
     *
     * The actual enforcement happens inside the Android Keystore via the
     * time-bound validity window; this method is the app-side fast-path that
     * avoids redundant BiometricPrompt UI when the OS is still authorising
     * Cipher operations.
     */
    fun needsAuth(autoApproveSeconds: Int): Boolean {
        val last = lastAuthAt ?: return true
        val elapsedMs = Date().time - last.time
        return elapsedMs > autoApproveSeconds.toLong() * 1_000L
    }

    /**
     * Reset the auto-approve window so the next request will require biometric.
     * Call when the app goes to background (mirrors iOS appDidEnterBackground).
     */
    fun resetAuthWindow() {
        lastAuthAt = null
    }

    // -------------------------------------------------------------------------
    // Callback-based authenticate — for use from non-coroutine contexts (Plugin)
    // -------------------------------------------------------------------------

    /**
     * Show a BiometricPrompt and deliver the result via callbacks.
     *
     * Posted to the UI thread via [activity].runOnUiThread; this is required
     * by BiometricPrompt. No CryptoObject is attached because SecureKeyStore
     * uses a time-bound master key (see ensureMasterKeyExists).
     *
     * [onSuccess] is called on the main thread with the AuthenticationResult.
     * [onError]   is called on the main thread with a human-readable message.
     */
    fun authenticateWithCallback(
        activity: FragmentActivity,
        reason: String,
        onSuccess: (AuthenticationResult) -> Unit,
        onError: (String) -> Unit,
    ) {
        activity.runOnUiThread {
            val executor = ContextCompat.getMainExecutor(activity)

            val callback = object : AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: AuthenticationResult) {
                    lastAuthAt = Date()
                    onSuccess(result)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    onError(errString.toString())
                }

                override fun onAuthenticationFailed() {
                    // Individual attempt failed; BiometricPrompt retries automatically.
                }
            }

            val prompt = BiometricPrompt(activity, executor, callback)

            val promptInfo = PromptInfo.Builder()
                .setTitle(LlmvaultMobileConfig.biometricPromptTitle)
                .setSubtitle(reason)
                .setNegativeButtonText("Cancel")
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .build()

            prompt.authenticate(promptInfo)
        }
    }
}

// -------------------------------------------------------------------------
// Exceptions
// -------------------------------------------------------------------------

/**
 * Thrown when BiometricPrompt authentication fails or is cancelled.
 * [errorCode] maps to BiometricPrompt.ERROR_* constants.
 */
class BiometricAuthException(
    val errorCode: Int,
    message: String,
) : Exception(message)
