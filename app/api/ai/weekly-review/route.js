import { NextResponse } from "next/server";

export async function POST(request) {
  const summary = await request.json();

  const prompt = `You are a disciplined trading coach reviewing a retail trader's week. Here is their trade data as JSON:
${JSON.stringify(summary)}

Write a concise weekly review in plain text using exactly these three headers on their own line: "WHAT WENT WELL", "MISTAKES MADE", "AVOID NEXT WEEK". Under each header put 2-4 short bullet points starting with "- ". Be specific, reference actual patterns in the data (e.g. instrument concentration, time of day, revenge trading signs in notes, risk sizing), and be direct but constructive. Do not add any other headers or preamble.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1000,
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
