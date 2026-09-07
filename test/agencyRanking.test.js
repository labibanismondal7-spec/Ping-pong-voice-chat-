const assert = require("assert");
const { initAgencyRankingService, EVENT_MS } = require("../agencyRanking.service");

function makeHarness() {
  const now = Date.now();
  const start = new Date(now - 10_000).toISOString();
  const data = {
    "agency_ranking_config.json": {
      durationDays: 7,
      eventStartAt: start,
      rewards: [
        { rank: 1, diamonds: 1000 },
        { rank: 2, diamonds: 500 },
        { rank: 3, diamonds: 250 }
      ]
    },
    "agency_ranking_rewards.json": []
  };
  const routes = [];
  const agencies = {
    ag1: { agencyId:"ag1", name:"Alpha Agency", ownerUserId:"u1", hostIds:[], countryId:"OTHERS", logo:"/logos/alpha.png" },
    ag2: { agencyId:"ag2", name:"Beta Agency", ownerUserId:"u2", hostIds:[], countryId:"OTHERS", logo:"/logos/beta.png" }
  };
  const users = {
    "m1": { userId:"u1", mobile:"m1", name:"Owner One", photo:"/photos/u1.png", agencyId:"ag1" },
    "m2": { userId:"u2", mobile:"m2", name:"Owner Two", photo:"/photos/u2.png", agencyId:"ag2" }
  };
  const giftHistory = [
    { transactionId:"t1", status:"confirmed", senderId:"g1", receiverId:"h1", agencyId:"ag1", diamondAmount:400, quantity:1, timestamp:new Date(now-2000).toISOString() },
    { transactionId:"t2", status:"confirmed", senderId:"g2", receiverId:"h2", agencyId:"ag1", diamondAmount:100, quantity:2, timestamp:new Date(now-1000).toISOString() },
    { transactionId:"t3", status:"confirmed", senderId:"g3", receiverId:"h3", agencyId:"ag2", diamondAmount:300, quantity:1, timestamp:new Date(now-500).toISOString() },
    // Invalid/duplicate records must never inflate the ranking.
    { transactionId:"t1", status:"confirmed", senderId:"g1", receiverId:"h1", agencyId:"ag1", diamondAmount:400, quantity:1, timestamp:new Date(now-2000).toISOString() },
    { transactionId:"bad", status:"refunded", senderId:"g9", agencyId:"ag1", diamondAmount:99999, timestamp:new Date(now).toISOString() }
  ];

  const app = {
    get(path, ...handlers) { routes.push(["GET", path, handlers]); },
    put(path, ...handlers) { routes.push(["PUT", path, handlers]); }
  };
  const io = { emit() {} };
  let hook = null;
  let saves = 0;
  const safeRead = (file, fallback) => data[file.split("/").pop()] ?? fallback;
  const safeWrite = (file, value) => { data[file.split("/").pop()] = value; };
  const findUserByUserId = (id) => {
    const u = Object.values(users).find(x => x.userId === String(id));
    return u ? { user:u } : null;
  };
  const svc = initAgencyRankingService({
    app, io, DATA_FOLDER:"/tmp/pingpong-agency-ranking-test",
    safeRead, safeWrite, userAuth:{ requireUserAuth:(req,res,next)=>next && next() },
    users, agencies, findUserByUserId, giftHistory,
    saveAgencies:()=>{ saves++; },
    registerGiftRecordedHook:(fn)=>{ hook=fn; },
    requireAdmin:(req,res,next)=>next && next(),
    requirePermission:()=> (req,res,next)=>next && next(),
    rbac:{ logAction(){} },
    actorCanAccessCountry:()=>true,
    countryDeniedResponse:(res)=>res,
    reqUserAgent:()=> "test"
  });
  return { svc, agencies, data, routes, get saves(){return saves;}, hook, now };
}

const h = makeHarness();
const event = h.svc.currentEvent();
const ranking = h.svc.buildRanking(event);
assert.strictEqual(ranking.length, 2);
assert.strictEqual(ranking[0].agencyId, "ag1");
assert.strictEqual(ranking[0].name, "Alpha Agency");
assert.strictEqual(ranking[0].diamonds, 500);
assert.strictEqual(ranking[0].giftCount, 3);
assert.strictEqual(ranking[1].agencyId, "ag2");
assert.strictEqual(ranking[1].diamonds, 300);

const payload = h.svc.eventPayload(event);
assert.strictEqual(payload.ranking[0].name, "Alpha Agency");
assert.strictEqual(Object.prototype.hasOwnProperty.call(payload.ranking[0], "ownerName"), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(payload.ranking[0], "hostName"), false);

const paid = h.svc.finalizeEvent({ eventId:"agency-ranking-test", startMs:event.startMs, endMs:event.endMs });
assert.strictEqual(paid.length, 2);
assert.strictEqual(h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag1").rankingRewardDiamonds, 1000);
assert.strictEqual(h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag2").rankingRewardDiamonds, 500);
assert.strictEqual(h.saves, 0);

// Idempotency: retrying the same event cannot pay again.
const paidAgain = h.svc.finalizeEvent({ eventId:"agency-ranking-test", startMs:event.startMs, endMs:event.endMs });
assert.strictEqual(paidAgain.length, 0);
assert.strictEqual(h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag1").rankingRewardDiamonds, 1000);
assert.strictEqual(h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag2").rankingRewardDiamonds, 500);

// A real gift hook causes only a ranking refresh; it never changes Agency
// reward balance by itself.
const before = h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag1").rankingRewardDiamonds;
assert.ok(typeof h.hook === "function");
h.hook();
assert.strictEqual(h.svc.eventPayload(event).ranking.find(x => x.agencyId === "ag1").rankingRewardDiamonds, before);

console.log("agencyRanking.test: PASS");
