const DEFAULT_AUTH_REDIRECT_DELAY_MS = 1500;
const DEFAULT_AUTH_IDLE_GRACE_MS = 1000;
const DEFAULT_AUTH_ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"];

/**
 * One copy of the auth overlay's words for every surface, matching the
 * AuthRedirectOverlay component in lagun and torrus: the expired state offers
 * the action, the logout state does not.
 */
export const AUTH_OVERLAY_COPY = {
  expired: {
    title: "Session expired",
    message: "Your session has ended. Redirecting to sign in…",
    action: "Sign in now",
  },
  logout: {
    title: "Signing out",
    message: "Ending your session…",
    action: "",
  },
};

/** React surfaces show their own overlay when this fires, the way lagun and
 *  torrus do; the DOM surfaces (admin) write the overlay directly. */
export const AUTH_REDIRECT_EVENT = "xwing:auth-redirect";
let reactRedirecting = false;

export function beginAuthRedirect(redirectDelayMs = DEFAULT_AUTH_REDIRECT_DELAY_MS) {
  if (reactRedirecting) return;
  reactRedirecting = true;
  window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT));
  window.setTimeout(() => redirectToLoginNow(), redirectDelayMs);
}

/** Cross-fade the boot card out under the shell instead of tearing it out.
 *  `immediate` is for an in-app handover: the panel before it already left the
 *  screen dark, so a spinner fading over the arriving shell is the flash. */
export function dismissBootCard(documentRef = document, windowRef = window, immediate = false) {
  const card = documentRef.querySelector(".boot-loading:not(.out)");
  if (!card) return;
  if (immediate) {
    (card.closest('[role="region"][aria-label="Loading"]') ?? card).remove();
    return;
  }
  card.classList.add("out");
  // The card sits inside a labelled landmark region so it isn't stray page
  // content while loading; remove that wrapper along with the card so an
  // empty landmark doesn't linger in the DOM afterward.
  const region = card.closest('[role="region"][aria-label="Loading"]');
  windowRef.setTimeout(() => (region ?? card).remove(), 240);
}

const HANDOVER_KEY = "xw-handover";
/** Long enough for a 170ms leave plus a slow navigation, short enough that a
 *  stale marker never reaches an unrelated cold load. */
const HANDOVER_WINDOW_MS = 5000;

/** Remember that the next document is another panel, not a cold load. */
export function markHandover(windowRef = window) {
  try { windowRef.sessionStorage.setItem(HANDOVER_KEY, String(Date.now())); } catch { /* storage can be denied */ }
}

/** True exactly once, in the document that follows a handover. */
export function consumeHandover(windowRef = window) {
  try {
    const at = windowRef.sessionStorage.getItem(HANDOVER_KEY);
    if (at === null) return false;
    windowRef.sessionStorage.removeItem(HANDOVER_KEY);
    return Date.now() - Number(at) < HANDOVER_WINDOW_MS;
  } catch { return false; }
}

export function currentAuthRedirectTarget(location = window.location) {
  return `${location.pathname || "/"}${location.search || ""}${location.hash || ""}`;
}

export function loginUrlForCurrentPage(location = window.location) {
  return `/_auth/login?redirect=${encodeURIComponent(currentAuthRedirectTarget(location))}`;
}

/** The overlay's action and the delayed redirect both land here. */
export function redirectToLoginNow(windowRef = window) {
  windowRef.location.assign(loginUrlForCurrentPage(windowRef.location));
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
  let overlayActionWired = false;

  function showAuthOverlay(copy) {
    const overlay = documentRef.getElementById("auth-overlay");
    if (!overlay) return;
    const titleEl = documentRef.getElementById("auth-overlay-title");
    const messageEl = documentRef.getElementById("auth-overlay-message");
    const actionEl = documentRef.getElementById("auth-overlay-action");
    if (titleEl) titleEl.textContent = copy.title;
    if (messageEl) messageEl.textContent = copy.message;
    if (actionEl) {
      actionEl.textContent = copy.action || "";
      actionEl.hidden = !copy.action;
      if (!overlayActionWired) {
        overlayActionWired = true;
        actionEl.addEventListener("click", () => redirectToLoginNow(windowRef));
      }
    }
    overlay.hidden = false;
  }

  function redirectToLogin() {
    if (authRedirecting) return;
    authRedirecting = true;
    showAuthOverlay(AUTH_OVERLAY_COPY.expired);
    windowRef.setTimeout(() => redirectToLoginNow(windowRef), redirectDelayMs);
  }

  function wireLogoutForm() {
    const form = documentRef.getElementById("logout-form");
    if (!form) return;
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (authRedirecting) return;
      authRedirecting = true;
      showAuthOverlay(AUTH_OVERLAY_COPY.logout);
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
