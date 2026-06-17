// hook.js — runs in the page's MAIN world, at document_start, in every frame
// (including the cross-origin poker game iframe). It PASSIVELY wraps
// window.WebSocket to observe inbound/outbound string frames and forwards a
// copy to the isolated-world bridge via window.postMessage.
//
// It NEVER alters, blocks, or replays traffic. Outbound frames are observed and
// then handed unchanged to the native send().
(function () {
  "use strict";
  if (window.__tenganHooked) return;
  window.__tenganHooked = true;

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;

  function forward(direction, url, data) {
    // Only string (JSON) frames are of interest.
    if (typeof data !== "string") return;
    try {
      window.postMessage(
        { __tengan: true, direction: direction, url: String(url), data: data, time: Date.now() },
        "*"
      );
    } catch (e) {
      /* ignore */
    }
  }

  function TenganWebSocket(url, protocols) {
    const ws =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    try {
      ws.addEventListener("message", function (event) {
        forward("in", url, event.data);
      });
    } catch (e) {
      /* ignore */
    }

    // Wrap send to observe (not modify) outbound frames.
    const nativeSend = ws.send.bind(ws);
    ws.send = function (data) {
      forward("out", url, data);
      return nativeSend(data);
    };

    return ws;
  }

  // Preserve prototype, constants, and instanceof behavior.
  TenganWebSocket.prototype = NativeWebSocket.prototype;
  TenganWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  TenganWebSocket.OPEN = NativeWebSocket.OPEN;
  TenganWebSocket.CLOSING = NativeWebSocket.CLOSING;
  TenganWebSocket.CLOSED = NativeWebSocket.CLOSED;

  try {
    window.WebSocket = TenganWebSocket;
  } catch (e) {
    // If reassignment fails, leave native WebSocket untouched.
  }
})();
