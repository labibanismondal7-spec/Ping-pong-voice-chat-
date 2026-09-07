// Focused production regression checks for the Diamonds -> Beans room gift
// flow and the previously missing Agency management/user routes.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const agency = fs.readFileSync(path.join(root, "agencyHost.js"), "utf8");

let pass = 0, fail = 0;
function assert(ok, msg) {
  if (ok) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("\n=== Room Gift: Diamonds -> Beans ===");
assert(server.includes('sender.diamonds = clampDiamondBalance(sender.userId'), "REST gift debits Diamonds");
assert(server.includes('target.user.beans = clampBeansBalance(target.user.userId'), "REST gift credits Beans");
assert(server.includes('logTransaction(sender.userId, "diamonds", -gift.price'), "REST sender ledger is Diamonds");
assert(server.includes('logTransaction(target.user.userId, "beans", gift.price'), "REST receiver ledger is Beans");
assert(server.includes('senderFound.user.diamonds = clampDiamondBalance(senderFound.user.userId'), "Socket gift debits Diamonds");
assert(server.includes('targetFound.user.beans = clampBeansBalance(targetFound.user.userId'), "Socket gift credits Beans");
assert(server.includes('logTransaction(senderFound.user.userId, "diamonds", -perTargetAmount'), "Socket sender ledger is Diamonds");
assert(server.includes('logTransaction(targetFound.user.userId, "beans", perTargetAmount'), "Socket receiver ledger is Beans");
assert(app.includes('me.beans = (me.beans || 0) + (data.gift.price || 0);'), "recipient UI updates Beans immediately");
assert(app.includes('if (!me.diamonds) { toast("Not enough Diamonds'), "gift UI checks Diamonds before send");

console.log("\n=== Agency creation / network-error root cause ===");
assert(server.includes('app.get("/api/admin/agency/list", requireAdmin, requirePermission("agencies:view")'), "Agency list endpoint exists");
assert(server.includes('app.post("/api/admin/agency/create", requireAdmin, requirePermission("agencies:manage")'), "Agency create endpoint exists");
assert(server.includes('app.post("/api/admin/agency/assign-host", requireAdmin, requirePermission("agencies:manage")'), "Agency host assignment endpoint exists");
assert(server.includes('app.get("/api/agency/mine/:userId", userAuth.requireUserAuth'), "User Agency endpoint exists and is authenticated");
assert(app.includes('socket.on("agency-status-update"'), "online Agency owner receives live status update");
assert(agency.includes('app.post("/api/agency/invite", requireUserAuth'), "Agency invite is authenticated");
assert(agency.includes('app.post("/api/agency/invite/respond", requireUserAuth'), "Agency invite response is authenticated");
assert(agency.includes('app.get("/api/agency/dashboard/:agencyId", requireUserAuth'), "Agency dashboard is authenticated");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
