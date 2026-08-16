(function installNaspetSocialChatWebPush(global) {
  "use strict";

  const deviceStorageKey = "naspet.social-chat.web-push.device-id.v1";
  const permissionCheckedStorageKey =
    "naspet.social-chat.web-push.permission-checked-at.v1";
  const serviceWorkerFile = "naspet-social-chat-push-sw.js";
  const recheckMilliseconds = 30 * 24 * 60 * 60 * 1000;
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function supported() {
    return Boolean(
      global.isSecureContext &&
        "serviceWorker" in navigator &&
        "PushManager" in global &&
        "Notification" in global &&
        global.crypto &&
        typeof global.crypto.getRandomValues === "function",
    );
  }

  function baseUrl() {
    const value = new URL(document.baseURI);
    if (value.origin !== global.location.origin) {
      throw new Error("push_base_origin_invalid");
    }
    return value;
  }

  function scopeUrl() {
    const value = baseUrl();
    if (!value.pathname.endsWith("/")) value.pathname += "/";
    value.search = "";
    value.hash = "";
    return value;
  }

  function serviceWorkerUrl() {
    return new URL(serviceWorkerFile, scopeUrl());
  }

  function registrationScriptUrl(workerRegistration) {
    return workerRegistration?.active?.scriptURL ||
      workerRegistration?.waiting?.scriptURL ||
      workerRegistration?.installing?.scriptURL ||
      null;
  }

  function isExpectedRegistration(workerRegistration) {
    return registrationScriptUrl(workerRegistration) ===
      serviceWorkerUrl().href;
  }

  function randomDeviceId() {
    if (typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(
      bytes,
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  function deviceId() {
    const existing = global.localStorage.getItem(deviceStorageKey);
    if (
      existing &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(
          existing,
        )
    ) {
      return existing;
    }
    const generated = randomDeviceId();
    global.localStorage.setItem(deviceStorageKey, generated);
    return generated;
  }

  function applicationServerKey(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,180}$/.test(value)) {
      throw new Error("vapid_public_key_invalid");
    }
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = global.atob(
      (value + padding).replace(/-/g, "+").replace(/_/g, "/"),
    );
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  async function registration(options) {
    if (!supported()) throw new Error("web_push_unsupported");
    const scope = scopeUrl();
    const script = serviceWorkerUrl();
    const existing = await navigator.serviceWorker.getRegistration(scope.href);
    if (existing && isExpectedRegistration(existing)) {
      await existing.update();
      return existing;
    }
    if (existing && options?.replaceUnexpectedRegistration !== true) {
      throw new Error("service_worker_scope_conflict");
    }
    if (existing) await existing.unregister();
    const created = await navigator.serviceWorker.register(script.href, {
      scope: scope.href,
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    if (created.scope !== scope.href) throw new Error("push_scope_invalid");
    return created;
  }

  function permissionState() {
    return supported() ? Notification.permission : "unsupported";
  }

  function markPermissionChecked() {
    const checkedAt = new Date().toISOString();
    global.localStorage.setItem(permissionCheckedStorageKey, checkedAt);
    return checkedAt;
  }

  function permissionNeedsRecheck() {
    const raw = global.localStorage.getItem(permissionCheckedStorageKey);
    const checkedAt = raw ? Date.parse(raw) : Number.NaN;
    return !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt >= recheckMilliseconds;
  }

  function subscriptionResult(subscription, checkedAt) {
    // Browser permission can be revoked outside the app while the PushManager
    // object still exists. Treat it as disabled so Flutter retires the server
    // device instead of attempting to decode an unusable granted snapshot.
    if (Notification.permission !== "granted") subscription = null;
    if (!subscription) {
      return {
        supported: true,
        enabled: false,
        deviceId: deviceId(),
        permissionState: Notification.permission,
        permissionCheckedAt: checkedAt,
      };
    }
    const value = subscription.toJSON();
    if (
      typeof value.endpoint !== "string" ||
      !value.keys ||
      typeof value.keys.p256dh !== "string" ||
      typeof value.keys.auth !== "string"
    ) {
      throw new Error("push_subscription_contract_invalid");
    }
    return {
      supported: true,
      enabled: true,
      deviceId: deviceId(),
      permissionState: Notification.permission,
      permissionCheckedAt: checkedAt,
      endpoint: value.endpoint,
      p256dhKey: value.keys.p256dh,
      authKey: value.keys.auth,
      contentEncoding: "aes128gcm",
    };
  }

  async function subscribe(vapidPublicKey) {
    if (!supported()) {
      return {
        supported: false,
        enabled: false,
        permissionState: "unsupported",
      };
    }
    let permission = Notification.permission;
    if (permission === "default") {
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        throw new Error("notification_permission_requires_user_gesture");
      }
      // This is the only permission prompt in this module.  The function is
      // called by the explicit settings action, never during page startup.
      permission = await Notification.requestPermission();
    }
    const checkedAt = markPermissionChecked();
    if (permission !== "granted") {
      return subscriptionResult(null, checkedAt);
    }
    const workerRegistration = await registration({
      replaceUnexpectedRegistration: false,
    });
    const existing = await workerRegistration.pushManager.getSubscription();
    const subscription = existing ||
      (await workerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(vapidPublicKey),
      }));
    return subscriptionResult(subscription, checkedAt);
  }

  async function currentSubscription() {
    if (!supported()) {
      return {
        supported: false,
        enabled: false,
        permissionState: "unsupported",
      };
    }
    const scope = scopeUrl();
    const workerRegistration = await navigator.serviceWorker.getRegistration(
      scope.href,
    );
    if (workerRegistration && isExpectedRegistration(workerRegistration)) {
      await workerRegistration.update();
    }
    const subscription = workerRegistration &&
        isExpectedRegistration(workerRegistration)
      ? await workerRegistration.pushManager.getSubscription()
      : null;
    // Reading browser state is not a completed server reconciliation. Keep a
    // due marker stale until the register/unregister RPC succeeds so a
    // transient failure cannot suppress retries for 30 days.
    const checkedAt = global.localStorage.getItem(permissionCheckedStorageKey) ||
      null;
    return subscriptionResult(subscription, checkedAt);
  }

  async function unsubscribe() {
    if (!supported()) {
      return {
        supported: false,
        enabled: false,
        permissionState: "unsupported",
      };
    }
    const scope = scopeUrl();
    const workerRegistration = await navigator.serviceWorker.getRegistration(
      scope.href,
    );
    const subscription = workerRegistration &&
        isExpectedRegistration(workerRegistration)
      ? await workerRegistration.pushManager.getSubscription()
      : null;
    if (subscription) await subscription.unsubscribe();
    return subscriptionResult(null, markPermissionChecked());
  }

  function consumeLaunchTarget() {
    const url = new URL(global.location.href);
    if (url.searchParams.get('open') !== 'social-chat') return {};
    const conversationId = url.searchParams.get('conversation_id') || '';
    url.searchParams.delete('open');
    url.searchParams.delete('conversation_id');
    global.history.replaceState(global.history.state, '', url.href);
    return uuidPattern.test(conversationId) ? { conversationId } : {};
  }

  global.NaspetSocialChatWebPush = Object.freeze({
    supported,
    permissionState,
    permissionNeedsRecheck,
    markPermissionChecked,
    subscribeJson: async (vapidPublicKey) =>
      JSON.stringify(await subscribe(vapidPublicKey)),
    currentSubscriptionJson: async () =>
      JSON.stringify(await currentSubscription()),
    unsubscribeJson: async () => JSON.stringify(await unsubscribe()),
    consumeLaunchTargetJson: () => JSON.stringify(consumeLaunchTarget()),
  });
})(window);
