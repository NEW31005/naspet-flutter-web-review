'use strict';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function safePayload(event) {
  if (!event.data) return null;
  try {
    const value = event.data.json();
    if (
      value &&
      value.version === 1 &&
      value.kind === 'social_chat' &&
      uuidPattern.test(value.conversationId) &&
      uuidPattern.test(value.messageId)
    ) {
      return {
        conversationId: value.conversationId,
        messageId: value.messageId,
      };
    }
  } catch (_) {
    // The visible notification remains generic even for an invalid payload.
  }
  return null;
}

self.addEventListener('push', (event) => {
  const payload = safePayload(event);
  const scope = new URL(self.registration.scope);
  const target = new URL(scope.href);
  target.searchParams.set('open', 'social-chat');
  if (payload) {
    target.searchParams.set('conversation_id', payload.conversationId);
  }
  event.waitUntil(
    self.registration.showNotification('ナスペット', {
      body: '新しいメッセージがあります',
      icon: new URL('icons/Icon-192.png', scope).href,
      badge: new URL('icons/Icon-192.png', scope).href,
      tag: payload
        ? `naspet-social-chat-${payload.conversationId}`
        : 'naspet-social-chat',
      renotify: true,
      data: { targetUrl: target.href },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = new URL(self.registration.scope);
  const rawTarget = event.notification.data?.targetUrl;
  let target = scope;
  try {
    const candidate = new URL(rawTarget, scope);
    if (
      candidate.origin === scope.origin &&
      candidate.pathname.startsWith(scope.pathname)
    ) {
      target = candidate;
    }
  } catch (_) {
    // Keep the scope root as a safe fallback.
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(
      async (clients) => {
        const sameScope = clients.find((client) => {
          try {
            const url = new URL(client.url);
            return url.origin === scope.origin &&
              url.pathname.startsWith(scope.pathname);
          } catch (_) {
            return false;
          }
        });
        if (sameScope) {
          if ('navigate' in sameScope) await sameScope.navigate(target.href);
          return await sameScope.focus();
        }
        return await self.clients.openWindow(target.href);
      },
    ),
  );
});
