import cn.guihualab.ttydhub.SavedServers;
import cn.guihualab.ttydhub.ServerAddress;
import java.util.List;

public class SavedServersTest {
    public static void main(String[] args) {
        String a = "https://alpha.example/", b = "http://192.0.2.2:8182/", c = "https://gamma.example/hub/";
        SavedServers servers = new SavedServers(null, a);
        check(servers.entries().equals(List.of(a)), "old installations keep their server");
        servers.remember(b);
        servers.remember(c);
        servers.remember(a);
        check(servers.entries().equals(List.of(a, c, b)), "switching keeps all servers, recent first");
        check(new SavedServers(servers.encode(), b).entries().equals(servers.entries()), "history survives app restart");
        servers.remember("https://ALPHA.example:443/");
        check(servers.entries().size() == 3, "host casing and default ports do not duplicate servers");
        servers.remember("http://alpha.example/");
        servers.remember("https://alpha.example:8443/");
        check(servers.entries().size() == 5, "different protocols and ports stay separate");
        servers.remember("https://gamma.example/another/");
        check(servers.entries().size() == 6, "different deployment paths stay available");
        servers.remove(b);
        check(!servers.contains(b) && servers.contains(c) && servers.contains(a), "removing one leaves the others intact");
        check(new SavedServers("", a).entries().isEmpty(), "removed legacy server is not resurrected");
        check(new SavedServers(null, "").entries().isEmpty(), "fresh install has no server");
        SavedServers repaired = new SavedServers(a + "\nfile:///private\nhttps://user:password@example.com\n" + b + "\n" + a, c);
        check(repaired.entries().equals(List.of(a, b)), "invalid entries are skipped without losing valid history");
        String before = servers.encode();
        try { servers.remember("https://user:password@example.com"); throw new AssertionError("accepted credentials in address"); }
        catch (IllegalArgumentException expected) { check(servers.encode().equals(before), "invalid add keeps existing servers"); }
        check(SavedServers.sameServer("https://alpha.example", a), "bare origin matches root page");
        check(!SavedServers.sameServer(a, a + "?other=1"), "distinct entry queries are preserved");
        check(ServerAddress.authScope("https://ALPHA.example:443/", "hub").equals(ServerAddress.authScope(a, "hub")), "existing encrypted login scope stays compatible");
        for (String other : List.of(b, c, "https://alpha.example:8443/", "http://alpha.example/")) {
            check(!ServerAddress.authScope(other, "hub").startsWith(ServerAddress.authScope(a, "")), "clearing A never removes another origin's login");
        }
        check(ServerAddress.authScope(a, "another-realm").startsWith(ServerAddress.authScope(a, "")), "all auth realms of the selected origin can be cleared");
        System.out.println("PASS: server history migration, persistence, switching, URL identity and login isolation");
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
