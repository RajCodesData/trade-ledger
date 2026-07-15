import { NextResponse } from "next/server";

export async function POST(request) {
  const { strategy, market, tenure } = await request.json();

  const prompt = `A retail trader wants a directional, qualitative assessment (not a real numerical historical backtest, since no market data is available) of this trading strategy:

Strategy: ${strategy}
Market/instrument: ${market || "not specified"}
Evaluation horizon: ${tenure}

Respond in plain text with exactly these headers, each on its own line: "LIKELY PROFITABILITY", "KEY STRENGTHS", "KEY RISKS", "WHAT WOULD IMPROVE THIS". Under LIKELY PROFITABILITY give one short paragraph with a qualitative call (e.g. low/medium/high probability of consistent profitability) and why, clearly stating this is a reasoned qualitative judgment, not a real backtest. Under the other three headers give 2-4 "- " bullet points each. Keep the whole response tight and specific to the strategy described, not generic trading advice.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1100,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    if (data.error) {
      console.error("OpenAI error:", data.error);
      return NextResponse.json({ text: "", error: data.error.message }, { status: 200 });
    }
    const text = data.choices?.[0]?.message?.content || "";
    return NextResponse.json({ text });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "AI request failed." }, { status: 500 });
  }
}
