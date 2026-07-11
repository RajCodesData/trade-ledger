import { NextResponse } from "next/server";

const SYSTEM_PROMPT = `You convert a retail trader's plain-English day-trading strategy into a strict JSON object. You must ONLY output valid JSON, nothing else - no markdown, no explanation.

The JSON must match this exact shape:
{
  "direction": "long" | "short",
  "entry_conditions": [
    {
      "metric": string,       // one of: "price", "vwap", "day_open", "prev_day_high", "prev_day_low", or "sma_N" / "ema_N" / "rsi_N" where N is a period like 9, 20, 50, 14
      "comparator": "above" | "below" | "crosses_above" | "crosses_below",
      "value_type": "number" | "metric",
      "value": number or metric-name-string   // matches value_type
    }
  ],   // ALL conditions must be true at the same time for entry to trigger (AND logic). Use 1-3 conditions - don't overcomplicate.
  "window_start": "HH:MM",   // 24hr, default "09:15"
  "window_end": "HH:MM",     // default "15:15"
  "stop_loss_pct": number,   // percent, positive number e.g. 0.5
  "target_pct": number,      // percent, positive number
  "qty": number,             // default 1 if not specified
  "summary": "one plain-English sentence restating the parsed rule"
}

Examples of metric usage:
- "price crosses above the 20-period moving average" -> {"metric":"price","comparator":"crosses_above","value_type":"metric","value":"sma_20"}
- "RSI drops below 30" -> {"metric":"rsi_14","comparator":"below","value_type":"number","value":30}
- "price above VWAP" -> {"metric":"price","comparator":"above","value_type":"metric","value":"vwap"}
- "9 EMA crosses above 21 EMA" -> {"metric":"ema_9","comparator":"crosses_above","value_type":"metric","value":"ema_21"}

If the strategy is ambiguous, make a reasonable interpretation and say so in the summary. If information is missing, use sensible defaults (qty 1, window 09:15-15:15, stop_loss_pct 0.5, target_pct 1, rsi_14 for plain "RSI").`;

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
