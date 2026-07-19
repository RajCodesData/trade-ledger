// Broker fee configurations. Add a new entry here when a new broker gets
// real order placement wired up - the calculation function below adapts
// automatically based on each broker's fee "shape" (percentage-based vs
// flat-per-order), so nothing else in the app needs to change.
const BROKER_FEE_CONFIGS = {
  delta: {
    type: "percentage",
    takerPct: 0.0005,  // 0.05% per side - our bracket orders execute as taker (market) on both entry and exit
    makerPct: 0.0002,  // 0.02% - not currently used since we only place market orders, kept for future limit-order support
    gstPct: 0.18,      // 18% GST charged on top of the fee amount (India)
  },
  // Placeholder for when Upstox gets real order placement. Upstox's actual
  // structure is different (flat ₹20/order for F&O, often free for equity
  // delivery, plus STT/exchange charges/stamp duty) - not percentage-based
  // like crypto. Fill this in properly before relying on it.
  upstox: {
    type: "flat",
    perOrderFee: 0,
    note: "Not yet configured - Upstox doesn't have real order placement built yet.",
  },
};

/**
 * Computes round-trip trading costs for a closed trade.
 * @param {string} broker - key into BROKER_FEE_CONFIGS, e.g. "delta"
 * @param {number} entryNotional - entry price × quantity × contract value (in the trade's quote currency, e.g. USD)
 * @param {number} exitNotional - exit price × quantity × contract value
 * @returns {{ fee: number, gst: number, totalCost: number } | null}
 */
export function calculateRoundTripFees(broker, entryNotional, exitNotional) {
  const config = BROKER_FEE_CONFIGS[broker];
  if (!config) return null;

  if (config.type === "percentage") {
    const entryFee = entryNotional * config.takerPct;
    const exitFee = exitNotional * config.takerPct;
    const fee = entryFee + exitFee;
    const gst = fee * (config.gstPct || 0);
    return { fee, gst, totalCost: fee + gst };
  }

  if (config.type === "flat") {
    const fee = (config.perOrderFee || 0) * 2; // entry + exit
    return { fee, gst: 0, totalCost: fee };
  }

  return null;
}
