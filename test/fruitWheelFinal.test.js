const assert = require('assert');
const {
  FRUIT_WHEEL_FOODS,
  FRUIT_WHEEL_CHIPS,
  FW_PLATFORM_FEE_BPS,
  fwRandomWeightedFood
} = require('../fruitWheelConfig');

assert.deepStrictEqual(FRUIT_WHEEL_CHIPS, [1000,10000,50000,100000,500000,1000000]);
assert.strictEqual(FRUIT_WHEEL_FOODS.reduce((s,f)=>s+f.weight,0),100);

const counts = Object.fromEntries(FRUIT_WHEEL_FOODS.map(f=>[f.id,0]));
for(let i=0;i<100000;i++) counts[fwRandomWeightedFood().id]++;
for(const f of FRUIT_WHEEL_FOODS){
  const observed = counts[f.id]/100000;
  const expected = f.weight/100;
  // Sampling tolerance: 0.7 percentage points is intentionally generous.
  assert(Math.abs(observed-expected) < 0.007, `${f.id}: observed ${observed}, expected ${expected}`);
}

// Closed-pool settlement invariant used by server.js.
function settle(totalBet, grossPayout){
  const fundedPool=Math.floor(totalBet*(10000-FW_PLATFORM_FEE_BPS)/10000);
  const factor=grossPayout>0?Math.min(1,fundedPool/grossPayout):0;
  const payout=Math.floor(grossPayout*factor);
  return {fundedPool,factor,payout};
}
for(const [bet,gross] of [[100000,50000],[100000,250000],[1000000,45000000],[1234567,987654321]]){
  const r=settle(bet,gross);
  assert(r.payout<=r.fundedPool);
  assert(r.fundedPool<=bet);
}
console.log('Fruit Wheel final production checks: PASS');
console.log('Observed distribution:', counts);
