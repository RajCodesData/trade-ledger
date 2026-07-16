import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { sendEmail } from "../../../../lib/sendEmail";

function fyEndDate(today) {
  // Indian FY ends March 31. If we're past March 31 this year, the relevant
  // end date is next year's March 31.
  const year = today.getMonth() >= 3 ? today.getFullYear() + 1 : today.getFullYear();
  return new Date(year, 2, 31);
}

export async function GET(request) {
  // Vercel automatically sends this header on its own scheduled cron calls,
  // authenticated against the CRON_SECRET environment variable you set.
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date();
  const fyEnd = fyEndDate(today);
  const daysLeft = Math.ceil((fyEnd - today) / (1000 * 60 * 60 * 24));
  const todayStr = today.toISOString().slice(0, 10);

  const { data: profiles } = await supabaseAdmin.from("profiles").select("*");
  const results = [];

  for (const p of profiles || []) {
    const reminderDays = p.harvest_reminder_days ?? 15;
    if (daysLeft > reminderDays || daysLeft < 0) { results.push({ user: p.id, skipped: "outside reminder window" }); continue; }
    if (p.last_harvest_email_sent === todayStr) { results.push({ user: p.id, skipped: "already sent today" }); continue; }

    const { data: positions } = await supabaseAdmin.from("open_positions")
      .select("*").eq("user_id", p.id).eq("segment", "equity_delivery").eq("side", "buy");

    if (!positions?.length) { results.push({ user: p.id, skipped: "no open equity positions" }); continue; }

    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(p.id);
      const email = userData?.user?.email;
      if (!email) continue;

      const rows = positions.map((pos) => {
        const daysHeld = Math.floor((today - new Date(pos.opened_at)) / (1000 * 60 * 60 * 24));
        const termNote = daysHeld > 365 ? "long-term (12.5% above ₹1.25L exemption)" : "short-term (20% flat)";
        return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${pos.instrument}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${pos.remaining_qty}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">₹${pos.avg_price}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${daysHeld} days (${termNote})</td></tr>`;
      }).join("");

      await sendEmail({
        to: email,
        subject: `📊 ${daysLeft} days left in FY — review these open positions for tax-loss harvesting`,
        html: `
          <p>The financial year ends in <b>${daysLeft} day${daysLeft === 1 ? "" : "s"}</b> (March 31). Only gains and losses realized (i.e. actually sold) by then count for this year's tax.</p>
          <p>Here are your currently open equity delivery positions on record:</p>
          <table style="border-collapse:collapse;width:100%;font-size:13px;">
            <tr style="background:#f5f5f5;"><th style="padding:6px 10px;text-align:left;">Instrument</th><th style="padding:6px 10px;text-align:left;">Qty</th><th style="padding:6px 10px;text-align:left;">Entry price</th><th style="padding:6px 10px;text-align:left;">Held</th></tr>
            ${rows}
          </table>
          <p style="margin-top:16px;"><b>What tax-loss harvesting means:</b> if any of these are currently trading below your entry price, selling before March 31 lets you book that loss, which can offset other capital gains you've realized this year and reduce your tax bill. India has no wash-sale rule for direct equities, so you're generally free to buy back in afterward if you still want the position — though this isn't tax advice, confirm with a CA for your specific situation.</p>
          <p style="color:#888;font-size:12px;">We can't yet pull live prices for these automatically — check current prices on your broker before deciding. You're getting this because you set a ${reminderDays}-day reminder window in the Tax tab; adjust or turn it off there anytime.</p>
        `,
      });
      await supabaseAdmin.from("profiles").update({ last_harvest_email_sent: todayStr }).eq("id", p.id);
      results.push({ user: p.id, action: "sent", positions: positions.length });
    } catch (e) {
      console.error("harvest email failed:", e);
      results.push({ user: p.id, error: String(e) });
    }
  }

  return NextResponse.json({ daysLeft, checked: (profiles || []).length, results });
}
