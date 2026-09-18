import cn.guihualab.ttydhub.ServerAddress;
public class ServerAddressTest {
    public static void main(String[] args) {
        check(ServerAddress.normalize(" example.com ").equals("https://example.com/"));
        check(ServerAddress.normalize("http://192.168.1.2:8182").equals("http://192.168.1.2:8182/"));
        check(ServerAddress.normalize("https://example.com/hub/").equals("https://example.com/hub/"));
        for (String bad : new String[]{"", "file:///etc/passwd", "javascript://alert(1)", "https://u:p@example.com", "https://example.com/#fragment", "http://x:99999", "http://x:0"}) {
            try { ServerAddress.normalize(bad); throw new AssertionError("Accepted " + bad); } catch (IllegalArgumentException expected) {}
        }
        check(ServerAddress.sameOrigin("https://example.com/", "https://example.com:443/terminal/a"));
        check(!ServerAddress.sameOrigin("https://example.com/", "https://example.com.evil.org/"));
        check(!ServerAddress.sameOrigin("https://example.com/", "http://example.com/"));
        check(!ServerAddress.sameOrigin("https://example.com/", "https://example.com:8443/"));
        check(!ServerAddress.sameOrigin("https://example.com/", "intent://test"));
        check(ServerAddress.authScope("https://EXAMPLE.com/", "hub").equals(ServerAddress.authScope("https://example.com:443/a", "hub")));
        check(!ServerAddress.authScope("http://example.com/", "hub").equals(ServerAddress.authScope("https://example.com/", "hub")));
        check(!ServerAddress.authScope("https://example.com:8443/", "hub").equals(ServerAddress.authScope("https://example.com/", "hub")));
        check(!ServerAddress.authScope("https://example.com/", "other").equals(ServerAddress.authScope("https://example.com/", "hub")));
        System.out.println("PASS: server URL validation and navigation origin policy");
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
}
