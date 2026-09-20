package cn.guihualab.ttydhub;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Credentials stay in this app; encryption key never leaves Android Keystore. */
final class LoginVault {
    private static final String ALIAS = "ttyd-hub-login-v1";
    private final SharedPreferences storage;
    LoginVault(Context context) { storage = context.getSharedPreferences("encrypted-logins", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (keys.containsAlias(ALIAS)) return (SecretKey) keys.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    void save(String scope, String username, String password) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
        JSONObject login = new JSONObject().put("username", username).put("password", password);
        String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(login.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!storage.edit().putString(scope, encrypted).commit()) throw new IllegalStateException("Cannot save login");
    }
    String[] load(String scope) {
        String value = storage.getString(scope, null); if (value == null) return null;
        try {
            String[] parts = value.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
            JSONObject login = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            return new String[]{login.getString("username"), login.getString("password")};
        } catch (Exception e) { storage.edit().remove(scope).apply(); return null; }
    }
    void remove(String scope) { storage.edit().remove(scope).apply(); }
    void removeServer(String address) {
        String prefix = ServerAddress.authScope(address, "");
        SharedPreferences.Editor edit = storage.edit();
        for (String scope : storage.getAll().keySet()) {
            if (scope.startsWith(prefix)) edit.remove(scope);
        }
        edit.apply();
    }
}
