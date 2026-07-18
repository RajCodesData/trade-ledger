// Sends an email via Resend (https://resend.com). Free tier covers this
// comfortably. Uses Resend's shared sandbox sender by default so you don't
// need to verify your own domain to get started - swap RESEND_FROM once you
// do want a custom "from" address.
export async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set - skipping email send");
    return { skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Traider <onboarding@resend.dev>",
        to: [to],
        subject,
        html,
      }),
    });
    return await res.json();
  } catch (e) {
    console.error("Email send failed:", e);
    return { error: String(e) };
  }
}
