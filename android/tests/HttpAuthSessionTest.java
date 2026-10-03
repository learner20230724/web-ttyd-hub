import cn.guihualab.ttydhub.HttpAuthSession;
import cn.guihualab.ttydhub.ServerAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class HttpAuthSessionTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    static class Store implements HttpAuthSession.Store {
        final Map<String, String[]> values = new HashMap<>();
        final List<String> removed = new ArrayList<>();
        boolean failSaving;
        public String[] load(String scope) { return values.get(scope); }
        public void save(String scope, String user, String pass) throws Exception {
            if (failSaving) throw new Exception("Synthetic storage failure");
            values.put(scope, new String[]{user, pass});
        }
        public void remove(String scope) { removed.add(scope); values.remove(scope); }
    }
    static class Request implements HttpAuthSession.Request {
        int completed;
        boolean cancelled;
        String user, pass;
        public void proceed(String user, String pass) {
            check(++completed == 1, "Each request must complete exactly once");
            this.user = user; this.pass = pass;
        }
        public void cancel() {
            check(++completed == 1, "A completed request must not be cancelled again");
            cancelled = true;
        }
    }

    public static void main(String[] args) throws Exception {
        String linux = ServerAddress.authScope("http://example.test:8182/", "restricted");
        String windows = ServerAddress.authScope("https://example.test/windows-hub/", "home-terminal");
        Store store = new Store();
        List<String> prompts = new ArrayList<>();
        HttpAuthSession auth = new HttpAuthSession(store, (scope, rejected) -> prompts.add(scope + "|" + rejected));

        // Initial HTML and concurrent asset/API challenges share a single dialog.
        List<Request> pending = new ArrayList<>();
        for (int i = 0; i < 8; i++) { Request r = new Request(); pending.add(r); auth.challenge(linux, true, r); }
        check(prompts.size() == 1, "Concurrent requests should show one login dialog");
        check(auth.submit("linux-user", "linux-password"), "Save entered login");
        for (Request r : pending) check(r.completed == 1 && "linux-password".equals(r.pass), "Deliver login to every waiting request");

        // The former global attemptedLogins set erased a valid password here.
        for (int i = 0; i < 20; i++) {
            Request r = new Request(); auth.challenge(linux, true, r);
            check(r.completed == 1 && "linux-user".equals(r.user), "Reuse saved login for a NEW request");
        }
        check(prompts.size() == 1 && store.removed.isEmpty(), "Repeated fresh challenges must not erase credentials or prompt");

        store.save(windows, "windows-user", "windows-password");
        Request rejected = new Request(); auth.challenge(linux, false, rejected);
        check(prompts.get(1).equals(linux + "|true"), "A server rejection should explain why input is requested");
        check(store.load(linux) == null && store.load(windows) != null, "Invalidate only the rejected server/realm");
        Request another = new Request(); auth.challenge(linux, true, another);
        Request wrongScope = new Request(); auth.challenge(windows, true, wrongScope);
        check(wrongScope.cancelled, "An open dialog must never supply another scope's credentials");
        check(auth.submit("linux-user", "corrected-password"), "Save corrected credentials");
        check("corrected-password".equals(rejected.pass) && "corrected-password".equals(another.pass), "Retry pending requests once");

        // Switching/reopening preserves the encrypted store but retires old requests.
        auth = new HttpAuthSession(store, (scope, retry) -> prompts.add(scope));
        Request restored = new Request(); auth.challenge(linux, true, restored);
        check("corrected-password".equals(restored.pass), "Reopen automatically reuses saved credentials");
        Request otherServer = new Request(); auth.challenge(windows, true, otherServer);
        check("windows-password".equals(otherServer.pass), "Other server keeps its own credentials");
        Request cancelled = new Request(); auth.challenge(linux, false, cancelled);
        auth.cancel(); auth.cancel();
        check(cancelled.cancelled && !auth.submit("stale", "stale"), "Cancelled/superseded dialogs cannot submit stale credentials");
        Request afterCancel = new Request(); auth.challenge(linux, true, afterCancel);
        store.failSaving = true;
        check(!auth.submit("temporary", "temporary-password"), "Report storage failure");
        check(afterCancel.completed == 1 && "temporary-password".equals(afterCancel.pass), "Storage failure must still allow current login");
        check(store.load(linux) == null && store.load(windows) != null, "Temporary credentials must not overwrite other servers");
        System.out.println("PASS: concurrent and repeated challenges, real rejection, correction, cancellation, reopen, server isolation and save failure");
    }
}
