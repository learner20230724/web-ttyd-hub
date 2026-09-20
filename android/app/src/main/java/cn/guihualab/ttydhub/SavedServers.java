package cn.guihualab.ttydhub;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** Address history only. Passwords remain in the separate encrypted LoginVault. */
public final class SavedServers {
    private final List<String> addresses = new ArrayList<>();

    public SavedServers(String stored, String legacyAddress) {
        // An explicitly empty list must not resurrect a server the user removed.
        String source = stored == null ? legacyAddress : stored;
        if (source == null) return;
        for (String value : source.split("\n")) {
            try {
                String address = ServerAddress.normalize(value);
                if (!contains(address)) addresses.add(address);
            } catch (IllegalArgumentException ignored) { /* Skip invalid old entries. */ }
        }
    }

    public void remember(String address) {
        String normalized = ServerAddress.normalize(address);
        remove(normalized);
        addresses.add(0, normalized);
    }

    public void remove(String address) { addresses.removeIf(value -> sameServer(value, address)); }
    public boolean contains(String address) { return addresses.stream().anyMatch(value -> sameServer(value, address)); }
    public List<String> entries() { return Collections.unmodifiableList(new ArrayList<>(addresses)); }
    public String encode() { return String.join("\n", addresses); }

    public static boolean sameServer(String first, String second) {
        try {
            URI a = URI.create(ServerAddress.normalize(first)), b = URI.create(ServerAddress.normalize(second));
            return ServerAddress.sameOrigin(a.toString(), b.toString()) &&
                path(a).equals(path(b)) && Objects.equals(a.getRawQuery(), b.getRawQuery());
        } catch (IllegalArgumentException e) { return false; }
    }

    private static String path(URI uri) { return uri.getRawPath().isEmpty() ? "/" : uri.getRawPath(); }
}
