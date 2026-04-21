package io.llmvault.mobile

import android.app.KeyguardManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.gson.Gson
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages LLM API key storage using Android Keystore + AES-GCM encryption.
 *
 * Security model (symmetric with iOS KeychainManager):
 * - An AES-256 master key lives in the Android Keystore under a pinned alias.
 *   The key requires biometric authentication at the OS boundary
 *   (setUserAuthenticationRequired(true)) with a time-bound validity window of
 *   [KEY_VALIDITY_SECONDS] seconds. The 5-minute window matches the iOS
 *   LAContext reuse cap so both platforms share the same effective semantics.
 * - Because the key is time-bound (not per-use), callers invoke
 *   BiometricPrompt without a CryptoObject. After a successful prompt the
 *   Keystore authorises decryption from any thread for the validity window;
 *   outside the window Cipher operations throw
 *   UserNotAuthenticatedException, which remains the OS-enforced backstop.
 * - Biometric enrolment changes invalidate the key
 *   (setInvalidatedByBiometricEnrollment(true)), preventing a stolen device
 *   whose attacker enrols their own biometric from reading stored keys.
 * - Each API key is AES/GCM encrypted with that master key and persisted
 *   inside EncryptedSharedPreferences ("secure_relay_keys_v2"). Metadata
 *   (baseUrl, model, keyHint) lives in a separate EncryptedSharedPreferences
 *   file ("secure_relay_meta_v2"). EncryptedSharedPreferences layers an
 *   additional AES-GCM on disk so even if the app's sandbox is read offline
 *   (e.g. forensic imaging) the files are opaque.
 * - Legacy ciphertext from earlier builds whose master key was generated
 *   without setUserAuthenticationRequired is detected and wiped on first
 *   access; users re-register keys on first launch after the upgrade. This
 *   migration is acceptable because the package has not shipped to users.
 */
class SecureKeyStore(private val context: Context) {

    // Android Keystore alias for the master AES key (configured via Plugin Config)
    private val keystoreAlias: String get() = LlmvaultMobileConfig.keystoreAlias

    // EncryptedSharedPreferences file names. Versioned so a schema change
    // (e.g. swapping to StrongBox) can coexist with an orderly migration.
    private val keysPrefsName = "secure_relay_keys_v2"
    private val metaPrefsName = "secure_relay_meta_v2"

    // Legacy file names from the pre-hardening layout — kept here so we can
    // delete them during migration. Do NOT read key material from these.
    private val legacyKeysPrefsName = "secure_relay_keys"
    private val legacyMetaPrefsName = "secure_relay_meta"

    // AES/GCM parameters
    private val aesKeySize = 256
    private val gcmTagLength = 128 // bits

    // IV storage suffix in SharedPreferences: "$provider.iv"
    private val ivSuffix = ".iv"

    private val gson = Gson()

    // Lazy EncryptedSharedPreferences — touches Keystore on first access.
    //
    // Both the Keystore-backed master key (SecureKeyStore) and the
    // EncryptedSharedPreferences wrapper key require the device to be
    // "secure" (i.e. the user has set a PIN / pattern / password /
    // biometric). If we dereference these on a device without a lock
    // screen, the Keystore subsystem throws at master-key generation with
    // an opaque message. We check explicitly and raise
    // [SecureStorageUnavailableException] so the plugin layer can map it
    // to a user-facing "Please set a device passcode" prompt.
    private val keysPrefs: SharedPreferences by lazy { openEncryptedPrefs(keysPrefsName) }
    private val metaPrefs: SharedPreferences by lazy { openEncryptedPrefs(metaPrefsName) }

    // -------------------------------------------------------------------------
    // API Key Storage — encrypted with Keystore-backed AES key
    // -------------------------------------------------------------------------

    /**
     * Encrypt and persist an API key for the given provider.
     *
     * Generates the master AES key in the Keystore if it does not already
     * exist, then encrypts [apiKey] with AES/GCM/NoPadding and stores the
     * ciphertext and IV inside the EncryptedSharedPreferences-backed
     * preferences file. The caller must have completed a BiometricPrompt
     * within the last [KEY_VALIDITY_SECONDS] seconds — the Keystore refuses
     * `Cipher.init(ENCRYPT_MODE, …)` otherwise and throws
     * UserNotAuthenticatedException.
     */
    fun saveKey(provider: String, apiKey: String) {
        ensureMasterKeyExists()

        val secretKey = getMasterKey()
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)

        val plaintext = apiKey.toByteArray(Charsets.UTF_8)
        val ciphertext = cipher.doFinal(plaintext)
        val iv = cipher.iv

        keysPrefs.edit()
            .putString(provider, android.util.Base64.encodeToString(ciphertext, android.util.Base64.NO_WRAP))
            .putString("$provider$ivSuffix", android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP))
            .apply()
    }

    /**
     * Decrypt and return the stored API key for the given provider.
     *
     * [cipher] must have been initialised via [getDecryptCipher] and the
     * caller must have completed a BiometricPrompt within the current
     * validity window. The Keystore throws UserNotAuthenticatedException
     * from doFinal() when that precondition is missing.
     *
     * @throws IllegalStateException if no key is stored for [provider].
     */
    fun loadKey(provider: String, cipher: Cipher): String {
        val ciphertextB64 = keysPrefs.getString(provider, null)
            ?: throw IllegalStateException("No key stored for provider: $provider")

        val ciphertext = android.util.Base64.decode(ciphertextB64, android.util.Base64.NO_WRAP)
        val plaintext = cipher.doFinal(ciphertext)
        return String(plaintext, Charsets.UTF_8)
    }

    /**
     * Delete the stored API key for the given provider.
     */
    fun deleteKey(provider: String) {
        keysPrefs.edit()
            .remove(provider)
            .remove("$provider$ivSuffix")
            .apply()
    }

    // -------------------------------------------------------------------------
    // Provider Metadata — encrypted at rest via EncryptedSharedPreferences
    // -------------------------------------------------------------------------

    fun saveMetadata(provider: String, metadata: ProviderMetadata) {
        val json = gson.toJson(metadata)
        metaPrefs.edit().putString(provider, json).apply()
    }

    fun loadMetadata(provider: String): ProviderMetadata? {
        val json = metaPrefs.getString(provider, null) ?: return null
        return runCatching { gson.fromJson(json, ProviderMetadata::class.java) }.getOrNull()
    }

    fun loadAllMetadata(): List<ProviderMetadata> {
        return metaPrefs.all.values.mapNotNull { raw ->
            if (raw is String) {
                runCatching { gson.fromJson(raw, ProviderMetadata::class.java) }.getOrNull()
            } else null
        }
    }

    fun deleteMetadata(provider: String) {
        metaPrefs.edit().remove(provider).apply()
    }

    // -------------------------------------------------------------------------
    // Cipher factory — Cipher returned here depends on a recent BiometricPrompt
    // -------------------------------------------------------------------------

    /**
     * Create a Cipher initialised for decryption of the given provider's key.
     *
     * The caller must have completed a BiometricPrompt within the validity
     * window before invoking [loadKey] with the returned cipher; without
     * that, `doFinal` will throw UserNotAuthenticatedException.
     *
     * @throws IllegalStateException if no IV is stored for [provider].
     */
    fun getDecryptCipher(provider: String): Cipher {
        val ivB64 = keysPrefs.getString("$provider$ivSuffix", null)
            ?: throw IllegalStateException("No IV stored for provider: $provider")
        val iv = android.util.Base64.decode(ivB64, android.util.Base64.NO_WRAP)

        val secretKey = getMasterKey()
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(gcmTagLength, iv))
        return cipher
    }

    // -------------------------------------------------------------------------
    // Keystore helpers
    // -------------------------------------------------------------------------

    private fun ensureMasterKeyExists() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }

        if (ks.containsAlias(keystoreAlias)) {
            if (isExistingKeyProperlyProtected(ks)) {
                return
            }
            Log.w(
                TAG,
                "Legacy master key without user-auth flag detected — wiping and regenerating."
            )
            wipeAllKeyMaterial(ks)
        }

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE,
        )
        val builder = KeyGenParameterSpec.Builder(
            keystoreAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(aesKeySize)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            // Re-enrolling a biometric invalidates the stored key so a thief
            // cannot re-register their own face/finger to bypass auth.
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                KEY_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(KEY_VALIDITY_SECONDS)
        }

        keyGenerator.init(builder.build())
        keyGenerator.generateKey()
    }

    /**
     * Returns true when the existing Keystore entry was generated with the
     * user-authentication flag. Legacy entries from before this hardening
     * return false and must be regenerated.
     */
    private fun isExistingKeyProperlyProtected(ks: KeyStore): Boolean {
        return try {
            val secretKey = (ks.getEntry(keystoreAlias, null) as? KeyStore.SecretKeyEntry)?.secretKey
                ?: return false
            val factory = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
            val info = factory.getKeySpec(secretKey, KeyInfo::class.java) as KeyInfo
            info.isUserAuthenticationRequired
        } catch (e: Exception) {
            Log.w(TAG, "Unable to inspect existing master key; treating as unsafe", e)
            false
        }
    }

    /**
     * Delete the master key and every SharedPreferences file that could hold
     * ciphertext or metadata. Used during the legacy-key migration and for
     * factory-reset style situations.
     */
    private fun wipeAllKeyMaterial(ks: KeyStore) {
        runCatching { ks.deleteEntry(keystoreAlias) }
        // Clear the v2 (EncryptedSharedPreferences) files if they were
        // populated ahead of the upgrade, and best-effort delete the legacy
        // v1 files.
        runCatching { context.getSharedPreferences(keysPrefsName, Context.MODE_PRIVATE).edit().clear().apply() }
        runCatching { context.getSharedPreferences(metaPrefsName, Context.MODE_PRIVATE).edit().clear().apply() }
        runCatching { context.deleteSharedPreferences(legacyKeysPrefsName) }
        runCatching { context.deleteSharedPreferences(legacyMetaPrefsName) }
    }

    private fun getMasterKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).also { it.load(null) }
        return (ks.getEntry(keystoreAlias, null) as KeyStore.SecretKeyEntry).secretKey
    }

    // -------------------------------------------------------------------------
    // EncryptedSharedPreferences bootstrap
    // -------------------------------------------------------------------------

    private fun openEncryptedPrefs(name: String): SharedPreferences {
        requireSecureDevice()
        val esPrefsMasterKey = try {
            MasterKey.Builder(context, "llmvault_mobile_prefs_master")
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
        } catch (e: Exception) {
            throw SecureStorageUnavailableException(
                "Unable to initialise the secure storage master key. " +
                    "Make sure the device has a screen lock enabled.",
                e,
            )
        }
        return try {
            EncryptedSharedPreferences.create(
                context,
                name,
                esPrefsMasterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            throw SecureStorageUnavailableException(
                "Secure storage is not available on this device. " +
                    "Set a PIN, password, or biometric unlock and try again.",
                e,
            )
        }
    }

    /**
     * Reject early if the device cannot back biometric-gated Keystore keys.
     * Without a screen lock, Keystore silently produces keys that behave in
     * surprising ways; we refuse outright so the user gets a clean error
     * instead of a confusing "key not found" later.
     */
    private fun requireSecureDevice() {
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (km == null || !km.isDeviceSecure) {
            throw SecureStorageUnavailableException(
                "Device lock screen not set. Enable a PIN, password, or " +
                    "biometric unlock in system settings, then reopen Travel OS.",
            )
        }
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    companion object {
        private const val TAG = "SecureKeyStore"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        /**
         * Validity window after a successful BiometricPrompt during which the
         * master key authorises Cipher operations. Matches iOS's
         * LATouchIDAuthenticationMaximumAllowableReuseDuration (300s).
         */
        private const val KEY_VALIDITY_SECONDS = 300
    }
}

// -------------------------------------------------------------------------
// Data types — mirrors iOS ProviderMetadata (KeychainManager.swift)
// -------------------------------------------------------------------------

/**
 * Non-sensitive provider configuration stored in EncryptedSharedPreferences.
 * Mirrors iOS ProviderMetadata. Never store key material here.
 */
data class ProviderMetadata(
    val provider: String,
    val baseUrl: String,
    val defaultModel: String,
    val keyHint: String?,
    val label: String?,
    val createdAt: Long,     // Unix epoch seconds
    val updatedAt: Long      // Unix epoch seconds
)

/**
 * Raised when the device is not in a state that supports biometric-gated
 * secure storage (no lock screen configured, Keystore initialisation
 * failed, etc.). The message is user-safe — plugin callers surface it
 * directly in UI copy.
 */
class SecureStorageUnavailableException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
