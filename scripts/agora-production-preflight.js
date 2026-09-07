#!/usr/bin/env node
// Production preflight for Agora room voice. Never prints secrets.
const required = ["AGORA_APP_ID", "AGORA_APP_CERTIFICATE"];
const missing = required.filter((k) => !String(process.env[k] || "").trim());
const mode = String(process.env.VOICE_MODE || "mesh").trim().toLowerCase();
const ttl = Number(process.env.AGORA_TOKEN_TTL_SECONDS || 3600);
console.log(`[agora-preflight] VOICE_MODE=${mode}`);
console.log(`[agora-preflight] AGORA_APP_ID=${process.env.AGORA_APP_ID ? "set" : "missing"}`);
console.log(`[agora-preflight] AGORA_APP_CERTIFICATE=${process.env.AGORA_APP_CERTIFICATE ? "set" : "missing"}`);
console.log(`[agora-preflight] AGORA_TOKEN_TTL_SECONDS=${Number.isFinite(ttl) && ttl > 0 ? ttl : "invalid"}`);
if (mode === "agora" && missing.length) {
  console.error(`[agora-preflight] FAIL: missing ${missing.join(", ")}`);
  process.exit(1);
}
if (mode === "agora" && (!Number.isFinite(ttl) || ttl < 300)) {
  console.error("[agora-preflight] FAIL: token TTL must be at least 300 seconds in production");
  process.exit(1);
}
console.log("[agora-preflight] PASS");
