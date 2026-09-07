'use strict';
const { assertSafeProduction } = require('../integration_update/config');
const { run } = require('../integration_update/database');
const { spawnSync } = require('child_process');
(async()=>{
  assertSafeProduction();
  await run({databaseUrl:process.env.DATABASE_URL});
  const hydration = spawnSync(process.execPath, [require.resolve('./hydrate-from-db.js')], { stdio: 'inherit', env: process.env });
  if (hydration.status !== 0) throw new Error(`Postgres hydration failed with exit code ${hydration.status}`);
  require('../server.js');
})().catch(err=>{ console.error('[production-start] startup aborted:',err.message); process.exit(1); });
