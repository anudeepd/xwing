const DEFAULT_AUTH_REDIRECT_DELAY_MS = 1500;
const DEFAULT_AUTH_IDLE_GRACE_MS = 1000;
const DEFAULT_AUTH_ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"];

export function currentAuthRedirectTarget(location = window.location) {
  return `${location.pathname || "/"}${location.search || ""}${location.hash || ""}`;
}

export function loginUrlForCurrentPage(location = window.location) {
  return `/_auth/login?redirect=${encodeURIComponent(currentAuthRedirectTarget(location))}`;
}

export function isLoginResponseUrl(url, baseHref = window.location.href) {
  if (!url) return false;
  try {
    return new URL(url, baseHref).pathname === "/_auth/login";
  } catch {
    return false;
  }
}

export function createAuthSession({
  documentRef = document,
  windowRef = window,
  fetchRef = fetch,
  redirectDelayMs = DEFAULT_AUTH_REDIRECT_DELAY_MS,
  idleTimeoutSeconds = 0,
  idleGraceMs = DEFAULT_AUTH_IDLE_GRACE_MS,
  activityEvents = DEFAULT_AUTH_ACTIVITY_EVENTS,
} = {}) {
  let authRedirecting = false;

  function showAuthOverlay(title, message) {
    const overlay = documentRef.getElementById("auth-overlay");
    if (!overlay) return;
    const titleEl = documentRef.getElementById("auth-overlay-title");
    const messageEl = documentRef.getElementById("auth-overlay-message");
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    overlay.hidden = false;
  }

  function redirectToLogin() {
    if (authRedirecting) return;
    authRedirecting = true;
    showAuthOverlay("Session expired", "Your session has ended. Redirecting to sign in...");
    windowRef.setTimeout(() => {
      windowRef.location.assign(loginUrlForCurrentPage(windowRef.location));
    }, redirectDelayMs);
  }

  function wireLogoutForm() {
    const form = documentRef.getElementById("logout-form");
    if (!form) return;
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (authRedirecting) return;
      authRedirecting = true;
      showAuthOverlay("Signing out", "Ending your session...");
      windowRef.setTimeout(() => form.submit(), redirectDelayMs);
    });
  }

  function wireAuthIdleTimer() {
    if (idleTimeoutSeconds <= 0) return () => {};
    const timeoutMs = idleTimeoutSeconds * 1000 + idleGraceMs;
    let timer = null;
    let deadline = Date.now() + timeoutMs;
    let expired = false;

    const expire = () => {
      if (expired) return;
      expired = true;
      if (timer !== null) windowRef.clearTimeout(timer);
      timer = null;
      redirectToLogin();
    };
    const armTimer = () => {
      if (timer !== null) windowRef.clearTimeout(timer);
      timer = windowRef.setTimeout(expire, Math.max(0, deadline - Date.now()));
    };
    const recordActivity = () => {
      if (expired) return;
      const now = Date.now();
      if (now >= deadline) {
        expire();
        return;
      }
      deadline = now + timeoutMs;
      armTimer();
    };
    const checkDeadline = () => {
      if (!expired && Date.now() >= deadline) expire();
    };
    for (const eventName of activityEvents) {
      windowRef.addEventListener(eventName, recordActivity, { passive: true });
    }
    for (const eventName of ["focus", "pageshow"]) {
      windowRef.addEventListener(eventName, checkDeadline, { passive: true });
    }
    documentRef.addEventListener("visibilitychange", checkDeadline, { passive: true });
    armTimer();

    return () => {
      if (timer !== null) windowRef.clearTimeout(timer);
      for (const eventName of activityEvents) {
        windowRef.removeEventListener(eventName, recordActivity);
      }
      for (const eventName of ["focus", "pageshow"]) {
        windowRef.removeEventListener(eventName, checkDeadline);
      }
      documentRef.removeEventListener("visibilitychange", checkDeadline);
    };
  }

  async function authFetch(input, init) {
    const res = await fetchRef(input, init);
    if (res.status === 401 || isLoginResponseUrl(res.url, windowRef.location.href)) {
      redirectToLogin();
      throw new Error("authentication required");
    }
    return res;
  }

  return {
    authFetch,
    isRedirecting: () => authRedirecting,
    redirectToLogin,
    showAuthOverlay,
    wireAuthIdleTimer,
    wireLogoutForm,
  };
}
