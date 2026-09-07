"use strict";

/**
 * PingPong Agency Ranking Event
 *
 * Server-authoritative source of truth:
 *   - agencies: real Agency records created by PingPong
 *   - giftHistory: the existing confirmed gift ledger
 *
 * No client-supplied Agency name, score, rank, user name, or reward is trusted.
 * A gift contributes only when the already-recorded giftHistory entry contains
 * a real agencyId. Ranking points are the Diamonds actually spent on that
 * confirmed gift during the active 7-day event.
 *
 * The event is a persistent 7-day window. The first window starts on first
 * initialization; every following window starts exactly when the previous
 * window ends. Finalization is idempotent, so a restart cannot pay a reward
 * twice.
 */
const path = require("path");
const crypto = require("crypto");

const EVENT_DAYS = 7;
const EVENT_MS = EVENT_DAYS * 24 * 60 * 60 * 1000;
const MAX_REWARD_DIAMONDS = 10_000_000_000;

const DEFAULT_CONFIG = {
  durationDays: EVENT_DAYS,
  rewards: [
    { rank: 1, diamonds: 100000 },
    { rank: 2, diamonds: 75000 },
    { rank: 3, diamonds: 50000 }
  ],
  eventStartAt: null
};

function finiteInt(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.floor(n), max));
}

function isoMs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initAgencyRankingService({
  app,
  io,
  DATA_FOLDER,
  safeRead,
  safeWrite,
  userAuth,
  users,
  agencies,
  findUserByUserId,
  giftHistory,
  registerGiftRecordedHook,
  requireAdmin,
  requirePermission,
  rbac,
  actorCanAccessCountry,
  countryDeniedResponse,
  reqUserAgent
}) {
  const CONFIG_FILE = path.join(DATA_FOLDER, "agency_ranking_config.json");
  const LEDGER_FILE = path.join(DATA_FOLDER, "agency_ranking_rewards.json");

  let config = normalizeConfig(safeRead(CONFIG_FILE, DEFAULT_CONFIG));
  const rawLedger = safeRead(LEDGER_FILE, []);
  let rewardLedger = Array.isArray(rawLedger) ? rawLedger : [];

  // The first production boot creates the real event start timestamp. It is
  // persisted, so refreshes/restarts never reset the seven-day countdown.
  if (!isoMs(config.eventStartAt)) {
    config.eventStartAt = new Date().toISOString();
    persistConfig();
  } else {
    persistConfig();
  }

  let finalizing = false;

  function persistConfig() {
    safeWrite(CONFIG_FILE, config);
  }

  function persistLedger() {
    safeWrite(LEDGER_FILE, rewardLedger);
  }

  function normalizeConfig(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const rewards = Array.isArray(src.rewards) ? src.rewards : DEFAULT_CONFIG.rewards;
    const normalizedRewards = [1, 2, 3].map((rank) => {
      const row = rewards.find((x) => Number(x && x.rank) === rank);
      return {
        rank,
        diamonds: finiteInt(row && row.diamonds, DEFAULT_CONFIG.rewards.find(x => x.rank === rank).diamonds, MAX_REWARD_DIAMONDS)
      };
    });
    return {
      durationDays: EVENT_DAYS,
      rewards: normalizedRewards,
      eventStartAt: isoMs(src.eventStartAt) ? new Date(src.eventStartAt).toISOString() : null
    };
  }

  function eventForStart(startMs) {
    const start = Math.floor(startMs);
    return {
      eventId: `agency-ranking-${new Date(start).toISOString()}`,
      startMs: start,
      endMs: start + EVENT_MS
    };
  }

  function currentEvent(nowMs = Date.now()) {
    let start = isoMs(config.eventStartAt);
    if (!start) {
      start = nowMs;
      config.eventStartAt = new Date(start).toISOString();
      persistConfig();
    }

    // If the process was down across one or more boundaries, finalize all
    // completed windows and advance the persisted start exactly one window at
    // a time. This keeps event IDs deterministic and prevents skipped weeks.
    while (nowMs >= start + EVENT_MS) {
      start += EVENT_MS;
    }
    if (start !== isoMs(config.eventStartAt)) {
      config.eventStartAt = new Date(start).toISOString();
      persistConfig();
    }
    return eventForStart(start);
  }

  function validGift(entry) {
    if (!entry || !entry.agencyId || !entry.senderId) return false;
    const amount = Number(entry.diamondAmount);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const status = String(entry.status || "confirmed").toLowerCase();
    return ["confirmed", "success", "completed"].includes(status);
  }

  function giftTime(entry) {
    const t = Date.parse(entry && (entry.timestamp || entry.time) || "");
    return Number.isFinite(t) ? t : 0;
  }

  function agencyRewardBalance(agencyId) {
    return rewardLedger
      .filter((x) => x && x.agencyId === String(agencyId) && x.status === "credited")
      .reduce((sum, x) => sum + finiteInt(x.rewardDiamonds, 0, MAX_REWARD_DIAMONDS), 0);
  }

  function publicAgency(agency) {
    if (!agency) return null;
    const owner = findUserByUserId ? findUserByUserId(agency.ownerUserId) : null;
    const profileImage = agency.logo || (owner && owner.user && (owner.user.photo || owner.user.avatar)) || "";
    return {
      agencyId: String(agency.agencyId),
      name: String(agency.name || "Agency"),
      profileImage: String(profileImage || ""),
      countryId: agency.countryId || "OTHERS",
      rankingRewardDiamonds: agencyRewardBalance(agency.agencyId)
    };
  }

  function entriesForEvent(event) {
    const seen = new Set();
    const out = [];
    for (const entry of Array.isArray(giftHistory) ? giftHistory : []) {
      if (!validGift(entry)) continue;
      const t = giftTime(entry);
      if (!t || t < event.startMs || t >= event.endMs) continue;
      const key = String(entry.transactionId || entry.giftHistoryId || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }

  function buildRanking(event = currentEvent()) {
    const totals = new Map();

    for (const entry of entriesForEvent(event)) {
      const agency = agencies[String(entry.agencyId)];
      if (!agency) continue;

      const amount = finiteInt(entry.diamondAmount, 0, MAX_REWARD_DIAMONDS);
      if (amount <= 0) continue;

      const id = String(agency.agencyId);
      const row = totals.get(id) || {
        diamonds: 0,
        giftCount: 0,
        lastGiftMs: 0
      };
      row.diamonds += amount;
      row.giftCount += Math.max(1, finiteInt(entry.quantity, 1, 100000));
      row.lastGiftMs = Math.max(row.lastGiftMs, giftTime(entry));
      totals.set(id, row);
    }

    // Every real Agency is eligible for display, including a newly-created
    // Agency with zero event activity. Its score is still zero until a
    // confirmed gift is recorded. This makes the page an actual Agency
    // directory + ranking rather than a list of fabricated competitors.
    const rows = [];
    for (const agency of Object.values(agencies || {})) {
      if (!agency || !agency.agencyId) continue;
      const agencyId = String(agency.agencyId);
      const total = totals.get(agencyId) || { diamonds: 0, giftCount: 0, lastGiftMs: 0 };
      const identity = publicAgency(agency);
      if (!identity) continue;
      rows.push({
        agencyId: identity.agencyId,
        name: identity.name,
        profileImage: identity.profileImage,
        rankingRewardDiamonds: identity.rankingRewardDiamonds,
        diamonds: total.diamonds,
        giftCount: total.giftCount,
        lastGiftAt: total.lastGiftMs ? new Date(total.lastGiftMs).toISOString() : null
      });
    }

    rows.sort((a, b) =>
      b.diamonds - a.diamonds ||
      b.giftCount - a.giftCount ||
      (isoMs(b.lastGiftAt) - isoMs(a.lastGiftAt)) ||
      a.agencyId.localeCompare(b.agencyId)
    );
    rows.forEach((row, index) => { row.rank = index + 1; });
    return rows;
  }

  function eventPayload(event = currentEvent()) {
    const ranking = buildRanking(event);
    const now = Date.now();
    return {
      success: true,
      event: {
        eventId: event.eventId,
        title: "Agency Ranking Event",
        durationDays: EVENT_DAYS,
        startAt: new Date(event.startMs).toISOString(),
        endAt: new Date(event.endMs).toISOString(),
        status: now < event.endMs ? "active" : "ended",
        remainingMs: Math.max(0, event.endMs - now),
        rewardDiamonds: clone(config.rewards)
      },
      ranking,
      generatedAt: new Date().toISOString()
    };
  }

  function rewardForRank(rank) {
    const row = config.rewards.find((x) => Number(x.rank) === Number(rank));
    return row ? finiteInt(row.diamonds, 0, MAX_REWARD_DIAMONDS) : 0;
  }

  function ledgerKey(eventId, agencyId, rank) {
    return `${eventId}|${agencyId}|${rank}`;
  }

  function alreadyPaid(eventId, agencyId, rank) {
    return rewardLedger.some((x) =>
      x && x.eventId === eventId && x.agencyId === agencyId && Number(x.rank) === Number(rank) &&
      x.status === "credited"
    );
  }

  function finalizeEvent(event) {
    if (finalizing) return [];
    finalizing = true;
    const credited = [];

    try {
      const ranking = buildRanking(event);
      // Zero-activity Agencies remain visible in the leaderboard, but never
      // receive an event reward merely because fewer than three Agencies
      // generated confirmed gifts.
      const top = ranking.filter((row) => Number(row.diamonds) > 0).slice(0, 3);

      for (const row of top) {
        const reward = rewardForRank(row.rank);
        if (reward <= 0 || alreadyPaid(event.eventId, row.agencyId, row.rank)) continue;

        const agency = agencies[row.agencyId];
        if (!agency) continue;

        // The reward ledger is the Agency-level credit ledger. Existing user
        // Diamonds are never silently credited: the current codebase has no
        // Agency wallet account, while `earnedDiamonds` belongs to the
        // commission domain. Keeping event rewards in their own append-only
        // ledger prevents cross-domain accounting and makes payout idempotent.
        const payoutId = `arp_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
        rewardLedger.push({
          payoutId,
          eventId: event.eventId,
          agencyId: row.agencyId,
          agencyName: row.name,
          rank: row.rank,
          rewardDiamonds: reward,
          rankingDiamonds: row.diamonds,
          creditedAt: new Date().toISOString(),
          status: "credited"
        });
        credited.push({
          payoutId,
          agencyId: row.agencyId,
          rank: row.rank,
          rewardDiamonds: reward
        });
      }

      if (credited.length) {
        persistLedger();
      }
      return credited;
    } finally {
      finalizing = false;
    }
  }

  function advanceAndFinalize() {
    // Finalize every completed event since the persisted event start, then
    // move the active window forward. A bounded loop protects a bad clock.
    let start = isoMs(config.eventStartAt);
    if (!start) return;

    let guard = 0;
    while (Date.now() >= start + EVENT_MS && guard++ < 104) {
      const event = eventForStart(start);
      finalizeEvent(event);
      start += EVENT_MS;
    }

    if (start !== isoMs(config.eventStartAt)) {
      config.eventStartAt = new Date(start).toISOString();
      persistConfig();
      broadcast();
    }
  }

  function broadcast() {
    try {
      io.emit("agency-ranking:update", eventPayload(currentEvent()));
    } catch (err) {
      console.error("[agency-ranking] broadcast failed:", err.message);
    }
  }

  function onGift() {
    // The gift itself has already been confirmed and persisted by the core
    // gift recorder. We only recompute and broadcast; no wallet mutation here.
    broadcast();
  }

  if (typeof registerGiftRecordedHook === "function") {
    registerGiftRecordedHook(onGift);
  }

  app.get("/api/agency-ranking", userAuth.requireUserAuth, (req, res) => {
    try {
      advanceAndFinalize();
      res.json(eventPayload(currentEvent()));
    } catch (err) {
      console.error("[agency-ranking] GET failed:", err);
      res.status(500).json({ success: false, message: "Agency ranking is temporarily unavailable" });
    }
  });

  app.get("/api/agency-ranking/history", userAuth.requireUserAuth, (req, res) => {
    const limit = Math.min(12, Math.max(1, finiteInt(req.query.limit, 6, 12)));
    const rows = rewardLedger
      .slice()
      .sort((a, b) => isoMs(b.creditedAt) - isoMs(a.creditedAt))
      .slice(0, limit);
    res.json({ success: true, rewards: rows.map((x) => ({
      eventId: x.eventId,
      agencyId: x.agencyId,
      agencyName: x.agencyName,
      rank: x.rank,
      rewardDiamonds: x.rewardDiamonds,
      creditedAt: x.creditedAt
    })) });
  });

  // Agency owner can see their own Agency-level event reward balance. No host
  // or owner names are exposed by the ranking page itself.
  app.get("/api/agency-ranking/mine/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== String(req.params.userId)) {
      return res.status(403).json({ success: false, message: "You can only access your own Agency" });
    }
    const agency = actor.agencyId ? agencies[actor.agencyId] : null;
    if (!agency) return res.json({ success: true, agency: null });
    const identity = publicAgency(agency);
    res.json({
      success: true,
      agency: {
        ...identity,
        rankingRewardDiamonds: agencyRewardBalance(agency.agencyId)
      }
    });
  });

  if (requireAdmin && requirePermission) {
    app.get("/api/admin/agency-ranking/config", requireAdmin, requirePermission("agencies:view"), (req, res) => {
      res.json({ success: true, config: clone(config) });
    });

    app.put("/api/admin/agency-ranking/config", requireAdmin, requirePermission("agencies:manage"), (req, res) => {
      const before = clone(config);
      const next = normalizeConfig({
        ...config,
        rewards: req.body && Array.isArray(req.body.rewards) ? req.body.rewards : config.rewards
      });
      config = next;
      persistConfig();

      if (rbac && typeof rbac.logAction === "function") {
        rbac.logAction({
          admin: req.adminAccount,
          action: "agency-ranking-config-update",
          module: "agency-ranking",
          targetType: "event-config",
          targetId: "agency-ranking",
          before,
          after: clone(config),
          ip: req.ip,
          userAgent: typeof reqUserAgent === "function" ? reqUserAgent(req) : "",
          result: "success"
        });
      }
      res.json({ success: true, config: clone(config) });
    });

    app.get("/api/admin/agency-ranking/rewards", requireAdmin, requirePermission("agencies:view"), (req, res) => {
      res.json({
        success: true,
        rewards: rewardLedger.slice().sort((a, b) => isoMs(b.creditedAt) - isoMs(a.creditedAt))
      });
    });
  }

  // Recovery/finalization check. 60 seconds is frequent enough for the
  // seven-day boundary while avoiding request-dependent payout behavior.
  const timer = setInterval(advanceAndFinalize, 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();

  // If a restart happened after the event boundary, settle it before the
  // first user request.
  advanceAndFinalize();

  return {
    buildRanking,
    currentEvent,
    eventPayload,
    finalizeEvent,
    advanceAndFinalize
  };
}

module.exports = {
  EVENT_DAYS,
  EVENT_MS,
  DEFAULT_CONFIG,
  initAgencyRankingService
};
