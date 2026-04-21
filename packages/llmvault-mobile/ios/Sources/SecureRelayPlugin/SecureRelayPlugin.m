#import <Capacitor/Capacitor.h>

CAP_PLUGIN(SecureRelayPlugin, "SecureRelay",
    CAP_PLUGIN_METHOD(registerKey, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(deleteKey, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(listProviders, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(testKey, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(chatStream, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cancelStream, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(updatePolicy, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getPolicy, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(checkBiometricAvailability, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(acceptPairing, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disconnectRelay, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getRelayStatus, CAPPluginReturnPromise);
)
