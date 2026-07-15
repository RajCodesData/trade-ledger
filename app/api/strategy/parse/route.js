import { NextResponse } from "next/server";

const SYSTEM_PROMPT = `You convert a retail trader's plain-English day-trading strategy into a strict JSON object. You must ONLY output valid JSON, nothing else - no markdown, no explanation.

The JSON must match this exact shape:
{
  "direction": "long" | "short",
  "entry_conditions": [
    {
      "metric": string,       // one of: "price", "vwap", "day_open", "prev_day_high", "prev_day_low", "prev_candle_high", "prev_candle_low", or "sma_N" / "ema_N" / "rsi_N" where N is a period like 9, 20, 50, 14
      "comparator": "above" | "below" | "crosses_above" | "crosses_below",
      "value_type": "number" | "metric",
      "value": number or metric-name-string
    }
  ],
  "window_start": "HH:MM",
  "window_end": "HH:MM",
  "stop_loss_type": "percent" | "candle_metric",
  "stop_loss_value": number,       // percent, only used when stop_loss_type is "percent"
  "stop_loss_metric": string,      // e.g. "prev_candle_high" or "prev_candle_low", only used when stop_loss_type is "candle_metric"
  "target_type": "percent" | "r_multiple",
  "target_value": number,          // percent if target_type is "percent", or the R-multiple (e.g. 5 for a 1:5 risk:reward) if "r_multiple"
  "max_risk_points": number or null,  // skip the trade if the stop distance in price points exceeds this; null if no such filter was mentioned
  "qty": number,
  "summary": "one plain-English sentence restating the parsed rule, and mention explicitly if any part of the original strategy could not be captured (e.g. trading options instead of the index, or vague volatility filters)"
}

Guidance:
- "previous candle's low/high" -> use metric "prev_candle_low" / "prev_candle_high" (NOT prev_day_low/high, which is the whole prior day).
- A stop-loss described as a specific level (e.g. "at the previous candle's high") -> stop_loss_type "candle_metric", stop_loss_metric set accordingly.
- A stop-loss described as a percent (e.g. "0.5% below entry") -> stop_loss_type "percent", stop_loss_value set.
- A target described as a risk multiple (e.g. "5 times the risk", "1:5 risk reward") -> target_type "r_multiple", target_value = the multiple.
- A target described as a percent -> target_type "percent", target_value set.
- If the strategy says to trade an option (e.g. "buy the ATM put") while the entry logic is based on the underlying index/stock, note this in the summary as NOT currently supported - the engine will paper-trade the underlying instrument itself, not an option contract, and this must be flagged, not silently ignored.
- Vague filters like "market is highly volatile" or "already made a large impulsive move" cannot be reliably quantified - omit them from entry_conditions and mention in the summary that they were not included.
- Use sensible defaults for anything unspecified: qty 1, window 09:15-15:15, stop_loss_type "percent" with stop_loss_value 0.5, target_type "percent" with target_value 1.
- If the strategy is about a cryptocurrency (Bitcoin, BTC, Ethereum, ETH, etc.), it trades 24/7 - unless the user specifies a window, use window_start "00:00" and window_end "23:55".`;

export async function POST(request) {
  const { description } = await request.json();
  if (!description || !description.trim()) {
    return NextResponse.json({ error: "Describe your strategy first." }, { status: 400 });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: description },
        ],
      }),
    });
    const data = await response.json();
    if (data.error) {
      return NextResponse.json({ error: data.error.message }, { status: 200 });
    }
    const raw = data.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Could not parse the AI's response. Try rephrasing your strategy." }, { status: 200 });
    }
    return NextResponse.json({ rules: parsed });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Strategy parsing failed." }, { status: 500 });
  }
}
