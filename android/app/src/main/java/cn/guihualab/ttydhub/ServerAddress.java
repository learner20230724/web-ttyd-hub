package cn.guihualab.ttydhub;

import java.net.URI;
import java.util.Locale;

/** Shared, testable URL policy. Only user-selected HTTP(S) origins are embedded. */
public final class ServerAddress {
    private ServerAddress() {}
    public static String normalize(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请输入服务器地址");
        if (!value.contains("://")) value = "https://" + value;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            if ((!scheme.equals("https") && !scheme.equals("http")) || uri.getHost() == null ||
                    uri.getUserInfo() != null || uri.getFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("请填写完整的 HTTP/HTTPS 地址，不要在地址中填写账号密码");
            }
            if (uri.getRawPath().isEmpty()) value += uri.getRawQuery() == null ? "/" : "";
            return value;
        } catch (java.net.URISyntaxException e) {
            throw new IllegalArgumentException("地址格式不正确，请检查域名、端口和空格");
        }
    }
    public static boolean sameOrigin(String first, String second) {
        try {
            URI a = new URI(first), b = new URI(second);
            if (a.getHost() == null || b.getHost() == null) return false;
            return a.getScheme().equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (Exception e) { return false; }
    }
    private static int port(URI uri) { return uri.getPort() >= 0 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80; }
}
