/* PingPong Agora RTC room voice — production client transport.
 * Uses Agora Web SDK 4.x, with the server as the sole token/role authority.
 * One Agora client per browser session; seated users publish microphone,
 * audience users subscribe only. Seat changes never tear down the channel.
 */
(function () {
  "use strict";
  const SDK_URL = "https://download.agora.io/sdk/release/AgoraRTC_N-4.24.7.js";
  let sdkPromise = null;
  let client = null;
  let micTrack = null;
  let roomId = null;
  let connected = false;
  let publishing = false;
  let leaving = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let tokenRenewTimer = null;
  const remoteUsers = new Set();

  function authToken() { return localStorage.getItem("pp_auth_token") || ""; }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function loadSdk() {
    if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => window.AgoraRTC ? resolve(window.AgoraRTC) : reject(new Error("Agora SDK global missing"));
      script.onerror = () => reject(new Error("Failed to load Agora Web SDK"));
      document.head.appendChild(script);
    }).catch(e => { sdkPromise = null; throw e; });
    return sdkPromise;
  }

  async function subscribeAndPlay(user, mediaType) {
    if (!client || !user || mediaType !== "audio") return;
    try {
      await client.subscribe(user, "audio");
      if (user.audioTrack) {
        remoteUsers.add(user.uid);
        user.audioTrack.play();
        // Android WebView can occasionally drop a remote track after a
        // network/seat transition without a new user-published event. A
        // short second play call is harmless and revives that edge case.
        setTimeout(() => {
          try { if (user.audioTrack) user.audioTrack.play(); } catch (_) {}
        }, 250);
      }
    } catch (e) { console.warn("[agora] subscribe/play failed:", e && e.message); }
  }

  async function replayRemoteAudio() {
    if (!client || !connected) return;
    const users = Array.isArray(client.remoteUsers) ? client.remoteUsers.slice() : [];
    for (const user of users) {
      try {
        if (user && user.hasAudio) await subscribeAndPlay(user, "audio");
        else if (user && user.audioTrack) { remoteUsers.add(user.uid); user.audioTrack.play(); }
      } catch (_) {}
    }
  }

  function roomVoiceEnabled() {
    return window.PingPongVoiceMode === "agora";
  }

  async function getToken() {
    const res = await fetch("/api/agora/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + authToken() },
      body: JSON.stringify({ roomId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || `Agora token request failed (${res.status})`);
    return data;
  }

  function ensureClient(AgoraRTC) {
    if (client) return client;
    client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    client.on("user-published", async (user, mediaType) => {
      if (mediaType === "audio") await subscribeAndPlay(user, mediaType);
      else {
        try { await client.subscribe(user, mediaType); } catch (e) { console.warn("[agora] subscribe failed:", e && e.message); }
      }
    });
    client.on("user-unpublished", (user) => {
      if (!user.audioTrack) remoteUsers.delete(user.uid);
    });
    client.on("user-left", (user) => remoteUsers.delete(user.uid));
    try {
      client.enableAudioVolumeIndicator();
      client.on("volume-indicator", (levels) => {
        const ctx = window.PingPongVoiceContext;
        const me = ctx && ctx.me;
        const socket = ctx && ctx.socket;
        const rid = ctx && ctx.roomId;
        const ownUid = client && client.uid;
        const own = Array.isArray(levels) && levels.find(v => String(v.uid) === String(ownUid));
        const speaking = !!(publishing && ctx && ctx.micEnabled && own && Number(own.level) > 5);
        if (socket && rid && me && speaking !== !!client.__ppSpeaking) {
          client.__ppSpeaking = speaking;
          socket.emit("voice-activity", { roomId: rid, speaking });
        }
      });
    } catch (_) {}
    client.on("token-privilege-will-expire", async () => {
      try { const data = await getToken(); await client.renewToken(data.token); scheduleTokenRenew(data.expiresAt); }
      catch (e) { console.warn("[agora] token renewal failed:", e && e.message); scheduleReconnect("token-renew"); }
    });
    client.on("token-privilege-did-expire", () => scheduleReconnect("token-expired"));
    client.on("connection-state-change", (cur, prev) => {
      if (["DISCONNECTED", "FAILED"].includes(cur) && !leaving) scheduleReconnect(`connection-${prev}-${cur}`);
      if (cur === "CONNECTED") {
        reconnectAttempt = 0;
        // Re-assert every existing subscription after network recovery or
        // a seat/audience transition. This keeps listeners hearing all 8
        // seated speakers even if the SDK did not emit a fresh publish event.
        replayRemoteAudio();
      }
    });
    return client;
  }

  function scheduleTokenRenew(expiresAt) {
    if (tokenRenewTimer) clearTimeout(tokenRenewTimer);
    if (!expiresAt) return;
    const ms = Math.max(30000, expiresAt * 1000 - Date.now() - 120000);
    tokenRenewTimer = setTimeout(async () => {
      try { const data = await getToken(); if (client) await client.renewToken(data.token); scheduleTokenRenew(data.expiresAt); }
      catch (_) { scheduleReconnect("scheduled-token-renew"); }
    }, ms);
  }

  function scheduleReconnect(reason) {
    if (leaving || !roomId || reconnectTimer) return;
    const ms = Math.min(30000, 500 * Math.pow(2, Math.min(reconnectAttempt++, 6)));
    console.warn("[agora] reconnect scheduled", reason, ms);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect({ room: roomId, publish: publishing });
        reconnectAttempt = 0;
      } catch (e) {
        console.warn("[agora] reconnect failed:", e && e.message);
        scheduleReconnect("retry");
      }
    }, ms);
  }

  async function connect({ room, publish }) {
    if (!room || !roomVoiceEnabled()) return false;
    roomId = room;
    leaving = false;
    const AgoraRTC = await loadSdk();
    const data = await getToken();
    const c = ensureClient(AgoraRTC);
    if (!connected) {
      await c.join(data.appId, data.channelName, data.token, data.uid);
      connected = true;
    } else if (c.uid !== data.uid) {
      throw new Error("Agora UID changed unexpectedly");
    } else {
      try { await c.renewToken(data.token); } catch (_) {}
    }
    scheduleTokenRenew(data.expiresAt);
    if (publish) await publishMic();
    else if (publishing) await unpublishMic();
    return true;
  }

  async function publishMic() {
    if (!client || !connected || publishing) return true;
    const AgoraRTC = window.AgoraRTC;
    if (!AgoraRTC) return false;
    if (!micTrack) micTrack = await AgoraRTC.createMicrophoneAudioTrack({
      encoderConfig: "speech_low_quality",
      AEC: true,
      ANS: true,
      AGC: true
    });
    await client.publish([micTrack]);
    publishing = true;
    return true;
  }

  async function unpublishMic({ release = false } = {}) {
    if (client && micTrack && publishing) {
      try { await client.unpublish([micTrack]); } catch (_) {}
    }
    publishing = false;
    if (release && micTrack) {
      try { micTrack.stop(); micTrack.close(); } catch (_) {}
      micTrack = null;
    }
    if (client && client.__ppSpeaking) {
      client.__ppSpeaking = false;
      const ctx = window.PingPongVoiceContext;
      if (ctx && ctx.socket && ctx.roomId) ctx.socket.emit("voice-activity", { roomId: ctx.roomId, speaking: false });
    }
  }

  async function releaseMic() {
    await unpublishMic({ release: true });
  }

  async function setPublishing(enabled) {
    if (!roomId) return false;
    if (enabled) return publishMic();
    await unpublishMic();
    return true;
  }

  async function disconnect() {
    leaving = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (tokenRenewTimer) clearTimeout(tokenRenewTimer);
    tokenRenewTimer = null;
    try { await unpublishMic(); } catch (_) {}
    if (micTrack) { try { micTrack.stop(); micTrack.close(); } catch (_) {} micTrack = null; }
    if (client && connected) { try { await client.leave(); } catch (_) {} }
    connected = false;
    publishing = false;
    roomId = null;
    remoteUsers.clear();
  }

  window.PingPongVoiceAgora = {
    isConnected: () => connected,
    isPublishing: () => publishing,
    connect,
    publishMic,
    unpublishMic,
    releaseMic,
    setPublishing,
    disconnect,
    getRemoteUserCount: () => remoteUsers.size
  };
})();
