import { NextResponse } from "next/server";

export async function POST(request) {
  const summary = await request.json();

  const prompt = `You are a disciplined trading coach reviewing a retail trader's week. Here is their trade data as JSON:
${JSON.stringify(summary)}

Write a concise weekly review in plain text using exactly these three headers on their own line: "WHAT WENT WELL", "MISTAKES MADE", "AVOID NEXT WEEK". Under each header put 2-4 short bullet points starting with "- ". Be specific, reference actual patterns in the data (e.g. instrument concentration, time of day, revenge trading signs in notes, risk sizing), and be direct but constructive. Do not add any other headers or preamble.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("\n");
    return NextResponse.json({ text });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "AI request failed." }, { status: 500 });
  }
}
