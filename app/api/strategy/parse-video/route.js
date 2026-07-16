import { NextResponse } from "next/server";

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

async function fetchTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const html = await pageRes.text();

  const titleMatch = html.match(/"title":"([^"]+)"/);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : null;

  const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!tracksMatch) return { title, transcript: null };

  let tracks;
  try {
    tracks = JSON.parse(tracksMatch[1]);
  } catch {
    return { title, transcript: null };
  }
  if (!tracks.length) return { title, transcript: null };

  const track = tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];
  const capRes = await fetch(track.baseUrl);
  const xml = await capRes.text();

  const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  const transcript = textMatches.map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, ""))).join(" ").replace(/\s+/g, " ").trim();

  return { title, transcript };
}

const SYSTEM_PROMPT = `You read a transcript of a trading/finance YouTube video and extract any concrete, rule-based trading strategy described in it, converting it into a strict JSON object. Output ONLY valid JSON, no markdown, no explanation.

The JSON must match this exact shape:
{
  "found_strategy": boolean,   // false if the transcript doesn't describe a concrete rule-based entry/exit strategy
  "direction": "long" | "short",
  "entry_conditions": [
    {
      "metric": string,       // one of: "price", "vwap", "day_open", "prev_day_high", "prev_day_low", "prev_candle_high", "prev_candle_low", or "sma_N" / "ema_N" / "rsi_N"
      "comparator": "above" | "below" | "crosses_above" | "crosses_below",
      "value_type": "number" | "metric",
      "value": number or metric-name-string
    }
  ],
  "window_start": "HH:MM",
  "window_end": "HH:MM",
  "timeframe": "1m" | "3m" | "5m" | "15m" | "30m" | "1h",
  "stop_loss_type": "percent" | "candle_metric",
  "stop_loss_value": number,
  "stop_loss_metric": string,
  "target_type": "percent" | "r_multiple",
  "target_value": number,
  "max_risk_points": number or null,
  "qty": number,
  "suggested_name": "a short 3-6 word name for this strategy",
  "summary": "2-3 sentences restating what was extracted, and explicitly noting anything from the video that could NOT be captured (e.g. chart patterns shown visually but not described in words, vague or missing rules, multiple different strategies mentioned)"
}

If the transcript is mostly commentary, opinion, or news with no concrete rule-based strategy, set found_strategy to false and explain why in summary - do not invent rules that weren't actually described. Use defaults for anything unspecified: qty 1, window 09:15-15:15 (or 00:00-23:55 if about crypto), timeframe "5m", stop_loss_type "percent" 0.5, target_type "percent" 1.`;

export async function POST(request) {
  const { url } = await request.json();
  const videoId = extractVideoId(url || "");
  if (!videoId) return NextResponse.json({ error: "That doesn't look like a valid YouTube URL." }, { status: 400 });

  let title, transcript;
  try {
    const result = await fetchTranscript(videoId);
    title = result.title;
    transcript = result.transcript;
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Could not fetch this video's page. Try again in a moment." }, { status: 500 });
  }

  if (!transcript) {
    return NextResponse.json({ error: "This video doesn't have captions available (auto-generated or manual), so a transcript couldn't be extracted." }, { status: 400 });
  }

  // Cap transcript length to keep prompt size reasonable for very long videos.
  const capped = transcript.length > 15000 ? transcript.slice(0, 15000) + "..." : transcript;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Video title: ${title || "unknown"}\n\nTranscript:\n${capped}` },
        ],
      }),
    });
    const data = await response.json();
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 200 });

    const raw = data.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return NextResponse.json({ error: "Could not parse the AI's response." }, { status: 200 }); }

    if (!parsed.found_strategy) {
      return NextResponse.json({ error: parsed.summary || "No concrete rule-based strategy was found in this video's transcript." }, { status: 200 });
    }

    return NextResponse.json({ rules: parsed, videoTitle: title });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Strategy extraction failed." }, { status: 500 });
  }
}
