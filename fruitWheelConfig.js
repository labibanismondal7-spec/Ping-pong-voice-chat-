// Fruit Wheel production configuration.
// Outcome selection is independent of player identity, selected fruit, and bet size.
// The fixed weights below are public/auditable probabilities, not per-user steering.
const crypto = require("crypto");

const FRUIT_WHEEL_FOODS = [
    { id: "orange", mult: 5, weight: 25 },
    { id: "lemon", mult: 5, weight: 25 },
    { id: "grape", mult: 5, weight: 15 },
    { id: "cherry", mult: 5, weight: 15 },
    { id: "apple", mult: 10, weight: 8 },
    { id: "watermelon", mult: 15, weight: 5 },
    { id: "mango", mult: 25, weight: 4 },
    { id: "strawberry", mult: 45, weight: 3 }
];

const FRUIT_WHEEL_CHIPS = [1000, 10000, 50000, 100000, 500000, 1000000];
const FW_PLATFORM_FEE_BPS = 1000; // 10%
const FW_MAX_PAYOUT_FACTOR = 1;

function fwRandomWeightedFood() {
    const totalWeight = FRUIT_WHEEL_FOODS.reduce((sum, food) => sum + food.weight, 0);
    let r = crypto.randomInt(0, totalWeight);
    for (const food of FRUIT_WHEEL_FOODS) {
        if (r < food.weight) return food;
        r -= food.weight;
    }
    return FRUIT_WHEEL_FOODS[0];
}

module.exports = {
    FRUIT_WHEEL_FOODS,
    FRUIT_WHEEL_CHIPS,
    FW_PLATFORM_FEE_BPS,
    FW_MAX_PAYOUT_FACTOR,
    fwRandomWeightedFood
};
