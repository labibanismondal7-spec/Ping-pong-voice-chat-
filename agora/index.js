// Agora RTC production integration for PingPong room voice.
// The browser is never trusted for identity or role. Every token request is
// authenticated and the server verifies that the caller belongs to the room.
const crypto = require("crypto");
const { mintRtcToken, isConfigured } = require("./token.js");

function useridToAgoraUid(userId) {
  const hash = crypto.createHash("sha256").update(String(userId)).digest();
  return (hash.readUInt32BE(0) % 0xFFFFFFFE) + 1;
}

function roomChannelName(roomId) {
  const hash = crypto.createHash("sha256").update(String(roomId)).digest("hex").slice(0, 40);
  return `pp_${hash}`;
}

function initAgora({ app, requireUserAuth, isRateLimited, users, rooms }) {
  function getAuthedUser(req) {
    const mobile = req.authedMobile;
    const user = mobile && users && users[mobile];
    return user || null;
  }

  function roomContainsUser(room, userId) {
    if (!room || !userId) return false;
    if (Array.isArray(room.onlineUsers) && room.onlineUsers.some((u) => u && u.userId === userId)) return true;
    if (Array.isArray(room.seats) && room.seats.some((s) => s && s.userId === userId)) return true;
    return false;
  }

  // Public mode/config endpoint contains no secrets. The guard keeps the
  // module testable with minimal injected app doubles while production
  // Express always provides app.get.
  if (app && typeof app.get === "function") {
    app.get("/api/agora/mode", (req, res) => {
      res.json({ success: true, voiceMode: (process.env.VOICE_MODE || "mesh").trim().toLowerCase(), configured: isConfigured() });
    });
  }

  // Authenticated, room-authorized RTC token endpoint.
  app.post("/api/agora/token", requireUserAuth, (req, res) => {
    try {
      const user = getAuthedUser(req);
      const userId = user && user.userId;
      if (!userId) return res.status(401).json({ success: false, message: "Login session expired — please log in again", forceLogout: true });
      if (isRateLimited(`agora-token:${userId}`, { windowMs: 3000, max: 5 })) return res.status(429).json({ success: false, message: "Too many requests" });
      if (!isConfigured()) return res.status(503).json({ success: false, message: "Agora is not configured" });

      const { roomId, role } = req.body || {};
      if (!roomId || typeof roomId !== "string") return res.status(400).json({ success: false, message: "roomId is required" });
      if (Buffer.byteLength(roomId, "utf8") > 128) return res.status(400).json({ success: false, message: "roomId is too long" });

      const room = rooms && rooms[roomId];
      if (!roomContainsUser(room, userId)) return res.status(403).json({ success: false, message: "You are not a member of this room" });

      const seated = Array.isArray(room.seats) && room.seats.some((s) => s && s.userId === userId);
      const effectiveRole = seated && role !== "subscriber" ? "publisher" : "subscriber";
      const channelName = roomChannelName(roomId);
      const uid = useridToAgoraUid(userId);
      const result = mintRtcToken({ channelName, uid, role: effectiveRole });
      return res.json({ success: true, roomId, ...result, role: effectiveRole });
    } catch (e) {
      const status = e && e.code === "AGORA_NOT_CONFIGURED" ? 503 : e && e.code === "AGORA_SDK_MISSING" ? 503 : /required|must be/.test(e.message || "") ? 400 : 500;
      if (status === 500) console.error("[agora] /token error:", e && e.message);
      return res.status(status).json({ success: false, message: (e && e.message) || "Failed to generate Agora token" });
    }
  });

  return { useridToAgoraUid, roomChannelName };
}

module.exports = { initAgora, useridToAgoraUid, roomChannelName };
