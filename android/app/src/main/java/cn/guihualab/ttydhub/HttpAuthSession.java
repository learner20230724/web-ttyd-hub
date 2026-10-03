package cn.guihualab.ttydhub;

import java.util.ArrayList;
import java.util.List;

/** Request-scoped HTTP authentication with one prompt for concurrent challenges. */
public final class HttpAuthSession {
    public interface Store {
        String[] load(String scope);
        void save(String scope, String username, String password) throws Exception;
        void remove(String scope);
    }
    public interface Request {
        void proceed(String username, String password);
        void cancel();
    }
    public interface Prompt { void show(String scope, boolean rejected); }

    private final Store store;
    private final Prompt prompt;
    private final List<Request> pending = new ArrayList<>();
    private String promptingScope;

    public HttpAuthSession(Store store, Prompt prompt) {
        this.store = store;
        this.prompt = prompt;
    }

    public void challenge(String scope, boolean canUseSaved, Request request) {
        if (promptingScope != null) {
            if (promptingScope.equals(scope)) pending.add(request);
            else request.cancel(); // Never apply one server/realm's dialog to another.
            return;
        }
        // This flag comes from HttpAuthHandler.useHttpAuthUsernamePassword():
        // false means rejection on THIS request, not an earlier challenge from
        // another asset, API request, navigation or connection.
        if (canUseSaved) {
            String[] saved = store.load(scope);
            if (saved != null) { request.proceed(saved[0], saved[1]); return; }
        } else store.remove(scope);
        promptingScope = scope;
        pending.add(request);
        prompt.show(scope, !canUseSaved);
    }

    public boolean submit(String username, String password) {
        if (promptingScope == null) return false;
        String scope = promptingScope;
        List<Request> requests = drain();
        boolean saved = true;
        try { store.save(scope, username, password); }
        catch (Exception e) { saved = false; }
        for (Request request : requests) request.proceed(username, password);
        return saved;
    }

    public void cancel() {
        for (Request request : drain()) request.cancel();
    }

    private List<Request> drain() {
        List<Request> requests = new ArrayList<>(pending);
        pending.clear();
        promptingScope = null;
        return requests;
    }
}
