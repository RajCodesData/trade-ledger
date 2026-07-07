"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// ---------- helpers ----------
function fmt(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function computePnl({ side, entryPrice, exitPrice, qty }) {
  const dir = side === "buy" ? 1 : -1;
  return (exitPrice - entryPrice) * qty * dir;
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getWeekRange(offset) {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}
function renderAiText(text, headerMap) {
  const lines = text.split("\n");
  let html = "", inList = false;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const headerKey = Object.keys(headerMap).find((h) => trimmed.toUpperCase().startsWith(h));
    if (headerKey) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h4>${headerMap[headerKey]}</h4>`;
    } else if (trimmed.startsWith("-")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${trimmed.replace(/^-\s*/, "").replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${trimmed}</p>`;
    }
  });
  if (inList) html += "</ul>";
  return html;
}

export default function Page() {
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div id="app-root"><div className="screen"><div className="content"><p className="muted-note">Loading...</p></div></div></div>;
  if (!session) return <div id="app-root"><AuthForm /></div>;
  return <div id="app-root"><Dashboard session={session} /></div>;
}

// ---------- AUTH ----------
function AuthForm() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  async function submit() {
    setError(""); setInfo("");
    if (!email || !password) { setError("Enter your email and password."); return; }
    setBusy(true);
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password });
      setBusy(false);
      if (error) { setError(error.message); return; }
      setInfo("Account created. Check your email to confirm, then log in.");
      setMode("login");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) { setError(error.message); return; }
    }
  }

  return (
    <div className="screen">
      <div className="auth-wrap">
        <div className="auth-logo">trade<span>ledger</span></div>
        <div className="auth-sub">{mode === "signup" ? "Create your journal account" : "Log in to your journal"}</div>
        <div className="field">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        {error && <div className="error-text">{error}</div>}
        {info && <div className="muted-note">{info}</div>}
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Log in"}
        </button>
        <div className="toggle-line">
          {mode === "signup" ? "Already have an account? " : "No account? "}
          <a onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(""); }}>
            {mode === "signup" ? "Log in" : "Create one"}
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ session }) {
  const user = session.user;
  const [tab, setTab] = useState("journal");
  const [trades, setTrades] = useState([]);
  const [profile, setProfile] = useState({ daily_loss_limit: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const { data: t } = await supabase.from("trades").select("*").eq("user_id", user.id).order("entry_time", { ascending: false });
    setTrades(t || []);
    const { data: p } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (!p) {
      await supabase.from("profiles").insert({ id: user.id });
      setProfile({ daily_loss_limit: null });
    } else {
      setProfile(p);
    }
    setLoading(false);
  }

  async function logout() {
    await supabase.auth.signOut();
  }

  const todayTrades = trades.filter((t) => t.entry_time.slice(0, 10) === todayStr());
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const limit = profile.daily_loss_limit;

  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand">trade<span>ledger</span></div>
        <button className="icon-btn" onClick={logout}>Log out ⏻</button>
      </div>

      {tab === "journal" && (
        <JournalTab trades={trades} todayPnl={todayPnl} limit={limit} user={user} onSaved={loadAll} />
      )}
      {tab === "guardrails" && (
        <GuardrailsTab trades={trades} profile={profile} user={user} onSaved={loadAll} />
      )}
      {tab === "analytics" && <AnalyticsTab trades={trades} />}
      {tab === "backtest" && <BacktestTab />}
      {tab === "broker" && <BrokerTab session={session} onSynced={loadAll} />}

      <div className="bottom-nav">
        {[
          ["journal", "📓", "Journal"],
          ["guardrails", "🛡️", "Guardrails"],
          ["analytics", "📊", "Analytics"],
          ["backtest", "🧪", "Backtest"],
          ["broker", "🔗", "Broker"],
        ].map(([id, icon, label]) => (
          <button key={id} className={"nav-btn" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
            <span>{icon}</span><span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- JOURNAL TAB ----------
function JournalTab({ trades, todayPnl, limit, user, onSaved }) {
  const [instrument, setInstrument] = useState("");
  const [side, setSide] = useState("buy");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [qty, setQty] = useState("");
  const [time, setTime] = useState(() => new Date().toISOString().slice(0, 16));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [confirmBreach, setConfirmBreach] = useState(false);
  const [saving, setSaving] = useState(false);

  function instrumentStats(name) {
    const list = trades.filter((t) => t.instrument.toLowerCase() === name.toLowerCase());
    if (!list.length) return null;
    const net = list.reduce((s, t) => s + t.pnl, 0);
    const wins = list.filter((t) => t.pnl > 0).length;
    return { count: list.length, net, winRate: Math.round((wins / list.length) * 100) };
  }
  const warnStats = instrument.trim() ? instrumentStats(instrument.trim()) : null;
  const showInstrumentWarning = warnStats && warnStats.count >= 3 && warnStats.net < 0;

  async function save(forceOverride) {
    setError("");
    const ep = parseFloat(entryPrice), xp = parseFloat(exitPrice), q = parseFloat(qty);
    if (!instrument.trim() || isNaN(ep) || isNaN(xp) || isNaN(q) || !time) {
      setError("Fill in instrument, entry, exit, quantity and time.");
      return;
    }
    if (limit && todayPnl <= -Math.abs(limit) && !forceOverride) {
      setConfirmBreach(true);
      return;
    }
    setSaving(true);
    const pnl = computePnl({ side, entryPrice: ep, exitPrice: xp, qty: q });
    const { error: err } = await supabase.from("trades").insert({
      user_id: user.id, instrument: instrument.trim(), side, entry_price: ep, exit_price: xp,
      qty: q, entry_time: new Date(time).toISOString(), notes, pnl, source: "manual",
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setInstrument(""); setEntryPrice(""); setExitPrice(""); setQty(""); setNotes(""); setConfirmBreach(false);
    setTime(new Date().toISOString().slice(0, 16));
    onSaved();
  }

  return (
    <div className="content">
      {limit && todayPnl <= -Math.abs(limit) && (
        <div className="banner danger">🛑 Daily loss limit reached. Today's P&L is {fmt(todayPnl)} against your {fmt(limit)} limit. Consider stepping away for the day.</div>
      )}
      {limit && todayPnl > -Math.abs(limit) && todayPnl <= -Math.abs(limit) * 0.7 && (
        <div className="banner warn">You're at {Math.round(Math.abs(todayPnl / limit) * 100)}% of your daily loss limit. Trade carefully.</div>
      )}

      <h2 className="section-title">Log a trade</h2>
      <div className="card">
        <div className="row">
          <div className="field">
            <label>Instrument</label>
            <input value={instrument} onChange={(e) => setInstrument(e.target.value)} placeholder="e.g. NIFTY, RELIANCE" />
          </div>
          <div className="field">
            <label>Side</label>
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="buy">Buy / Long</option>
              <option value="sell">Sell / Short</option>
            </select>
          </div>
        </div>
        {showInstrumentWarning && (
          <div className="banner warn">⚠️ You've traded <b>{instrument}</b> {warnStats.count} times with a net loss of {fmt(Math.abs(warnStats.net))} (win rate {warnStats.winRate}%). Consider skipping it or revisiting your rules before this trade.</div>
        )}
        <div className="row">
          <div className="field"><label>Entry price</label><input type="number" step="0.01" value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} /></div>
          <div className="field"><label>Exit price</label><input type="number" step="0.01" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} /></div>
        </div>
        <div className="row">
          <div className="field"><label>Quantity</label><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="field"><label>Entry time</label><input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Notes (setup, reasoning, mistake if any)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was the plan? Did you follow it?" />
        </div>
        {confirmBreach && (
          <div className="banner danger">
            You've hit your daily loss limit. Save anyway?
            <button className="ghost" style={{ marginTop: 10 }} onClick={() => save(true)}>Yes, save this trade anyway</button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <button className="primary" disabled={saving} onClick={() => save(false)}>{saving ? "Saving..." : "Save trade"}</button>
      </div>

      <h2 className="section-title">Today</h2>
      <div className="card">
        <div className="row">
          <div><div className="trade-meta">Trades today</div><div className="pnl">{todayPnlCount(trades)}</div></div>
          <div><div className="trade-meta">P&L today</div><div className={"pnl " + (todayPnl >= 0 ? "pos" : "neg")}>{fmt(todayPnl)}</div></div>
        </div>
      </div>

      <h2 className="section-title">Recent trades</h2>
      <div className="card">
        {trades.length === 0 ? (
          <div className="empty-state">No trades logged yet. Add your first trade above.</div>
        ) : (
          trades.slice(0, 10).map((t) => (
            <div className="trade-row" key={t.id}>
              <div>
                <div className="trade-instr">{t.instrument} · {t.side === "buy" ? "Long" : "Short"}{t.source === "upstox" ? " · synced" : ""}</div>
                <div className="trade-meta">{new Date(t.entry_time).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · Qty {t.qty} · {t.entry_price} → {t.exit_price}</div>
              </div>
              <div className={"pnl " + (t.pnl >= 0 ? "pos" : "neg")}>{fmt(t.pnl)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
function todayPnlCount(trades) {
  return trades.filter((t) => t.entry_time.slice(0, 10) === todayStr()).length;
}

// ---------- GUARDRAILS TAB ----------
function GuardrailsTab({ trades, profile, user, onSaved }) {
  const [limitInput, setLimitInput] = useState(profile.daily_loss_limit || "");
  const [saving, setSaving] = useState(false);

  async function saveLimit() {
    const val = parseFloat(limitInput);
    if (isNaN(val) || val <= 0) return;
    setSaving(true);
    await supabase.from("profiles").update({ daily_loss_limit: val }).eq("id", user.id);
    setSaving(false);
    onSaved();
  }

  const todayPnl = trades.filter((t) => t.entry_time.slice(0, 10) === todayStr()).reduce((s, t) => s + t.pnl, 0);
  const limit = profile.daily_loss_limit;
  const usedPct = limit ? Math.min(100, Math.max(0, (Math.max(0, -todayPnl) / limit) * 100)) : 0;
  const fillColor = usedPct >= 100 ? "var(--loss)" : usedPct >= 70 ? "var(--warn)" : "var(--profit)";

  const byInstr = {};
  trades.forEach((t) => {
    byInstr[t.instrument] = byInstr[t.instrument] || { count: 0, net: 0, wins: 0 };
    byInstr[t.instrument].count++;
    byInstr[t.instrument].net += t.pnl;
    if (t.pnl > 0) byInstr[t.instrument].wins++;
  });
  const flagged = Object.entries(byInstr).filter(([, v]) => v.count >= 3 && v.net < 0);

  return (
    <div className="content">
      <h2 className="section-title">Daily loss limit</h2>
      <div className="card">
        <div className="field">
          <label>Set your max acceptable loss for one day (₹)</label>
          <input type="number" value={limitInput} onChange={(e) => setLimitInput(e.target.value)} placeholder="e.g. 2000" />
        </div>
        <button className="primary" disabled={saving} onClick={saveLimit}>{saving ? "Saving..." : "Save limit"}</button>
      </div>

      <h2 className="section-title">Today's risk pulse</h2>
      <div className="card">
        <div className="risk-gauge-track">
          <div className={"risk-gauge-fill" + (usedPct >= 70 ? " pulse" : "")} style={{ width: usedPct + "%", background: limit ? fillColor : "var(--border)" }} />
        </div>
        <div className="muted-note">
          {limit ? `Today's P&L: ${fmt(todayPnl)} · Limit: ${fmt(limit)} · ${Math.round(usedPct)}% of limit used` : "Set a daily loss limit to activate this."}
        </div>
      </div>

      <h2 className="section-title">Instrument watchlist (auto-flagged)</h2>
      <div className="card">
        {flagged.length === 0 ? (
          <div className="empty-state">No instruments flagged yet — needs 3+ trades with a net loss to appear here.</div>
        ) : (
          flagged.map(([k, v]) => (
            <div className="trade-row" key={k}>
              <div><div className="trade-instr">{k}</div><div className="trade-meta">{v.count} trades · win rate {Math.round((v.wins / v.count) * 100)}%</div></div>
              <div className="pnl neg">{fmt(v.net)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------- ANALYTICS TAB ----------
function AnalyticsTab({ trades }) {
  const [offset, setOffset] = useState(0);
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);

  const { monday, sunday } = getWeekRange(offset);
  const weekTrades = trades.filter((t) => {
    const d = new Date(t.entry_time);
    return d >= monday && d <= sunday;
  });
  const net = weekTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = weekTrades.filter((t) => t.pnl > 0);
  const losses = weekTrades.filter((t) => t.pnl < 0);
  const winRate = weekTrades.length ? Math.round((wins.length / weekTrades.length) * 100) : 0;

  async function runReview() {
    if (weekTrades.length === 0) { setOutput(`<div class="empty-state">No trades logged for this week yet.</div>`); return; }
    setLoading(true); setOutput("");
    const byInstr = {};
    weekTrades.forEach((t) => {
      byInstr[t.instrument] = byInstr[t.instrument] || { count: 0, net: 0 };
      byInstr[t.instrument].count++; byInstr[t.instrument].net += t.pnl;
    });
    const summary = {
      totalTrades: weekTrades.length,
      netPnl: net,
      winRate,
      byInstrument: byInstr,
      trades: weekTrades.map((t) => ({ instrument: t.instrument, side: t.side, pnl: Math.round(t.pnl), time: t.entry_time, notes: t.notes })),
    };
    try {
      const res = await fetch("/api/ai/weekly-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(summary) });
      const data = await res.json();
      const headerMap = { "WHAT WENT WELL": "✅ What went well", "MISTAKES MADE": "⚠️ Mistakes made", "AVOID NEXT WEEK": "🚫 Avoid next week" };
      setOutput(renderAiText(data.text || "", headerMap));
    } catch (e) {
      setOutput(`<div class="banner danger">Could not reach the AI review service. Please try again.</div>`);
    }
    setLoading(false);
  }

  return (
    <div className="content">
      <div className="week-nav">
        <button onClick={() => setOffset(offset - 1)}>‹ Prev</button>
        <span className="week-label">{monday.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – {sunday.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}{offset === 0 ? " (this week)" : ""}</span>
        <button onClick={() => offset < 0 && setOffset(offset + 1)}>Next ›</button>
      </div>

      <div className="stat-grid">
        <div className="stat-box"><div className="label">Trades</div><div className="value">{weekTrades.length}</div></div>
        <div className="stat-box"><div className="label">Net P&L</div><div className="value" style={{ color: net >= 0 ? "var(--profit)" : "var(--loss)" }}>{fmt(net)}</div></div>
        <div className="stat-box"><div className="label">Win rate</div><div className="value">{winRate}%</div></div>
        <div className="stat-box"><div className="label">Avg loss</div><div className="value" style={{ color: "var(--loss)" }}>{losses.length ? fmt(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : "–"}</div></div>
      </div>

      <h2 className="section-title">AI weekly review</h2>
      <div className="card">
        <button className="primary" disabled={loading} onClick={runReview}>{loading ? "Analyzing..." : "Generate this week's review"}</button>
        {loading && <div style={{ textAlign: "center", padding: "14px 0" }}><span className="spinner"></span>Analyzing your week...</div>}
        {!loading && output && <div className="ai-output" dangerouslySetInnerHTML={{ __html: output }} />}
      </div>
    </div>
  );
}

// ---------- BACKTEST TAB ----------
function BacktestTab() {
  const [strategy, setStrategy] = useState("");
  const [market, setMarket] = useState("");
  const [tenure, setTenure] = useState("1 year");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setError("");
    if (!strategy.trim()) { setError("Describe your strategy first."); return; }
    setLoading(true); setOutput("");
    try {
      const res = await fetch("/api/ai/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strategy, market, tenure }) });
      const data = await res.json();
      const headerMap = { "LIKELY PROFITABILITY": "📈 Likely profitability", "KEY STRENGTHS": "💪 Key strengths", "KEY RISKS": "⚠️ Key risks", "WHAT WOULD IMPROVE THIS": "🛠️ What would improve this" };
      setOutput(renderAiText(data.text || "", headerMap) + `<div class="muted-note">This is an AI-generated qualitative read based on your description, not a statistical backtest against real historical price data.</div>`);
    } catch (e) {
      setOutput(`<div class="banner danger">Could not reach the AI assessment service. Please try again.</div>`);
    }
    setLoading(false);
  }

  return (
    <div className="content">
      <h2 className="section-title">Describe your strategy</h2>
      <div className="card">
        <div className="field">
          <label>Strategy / rules</label>
          <textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} placeholder="e.g. Buy NIFTY breakout above previous day high with volume confirmation, stop loss 0.5%, target 1.5%, only trade 9:20-11:00am" />
        </div>
        <div className="row">
          <div className="field"><label>Market / instrument</label><input value={market} onChange={(e) => setMarket(e.target.value)} placeholder="e.g. NIFTY 50 index options" /></div>
          <div className="field">
            <label>Tenure to evaluate</label>
            <select value={tenure} onChange={(e) => setTenure(e.target.value)}>
              <option>3 months</option><option>6 months</option><option>1 year</option><option>2 years</option>
            </select>
          </div>
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="primary" disabled={loading} onClick={run}>{loading ? "Assessing..." : "Run AI assessment"}</button>
        {loading && <div style={{ textAlign: "center", padding: "14px 0" }}><span className="spinner"></span>Assessing strategy...</div>}
        {!loading && output && <div className="ai-output" dangerouslySetInnerHTML={{ __html: output }} />}
      </div>
    </div>
  );
}

// ---------- BROKER TAB ----------
function BrokerTab({ session, onSynced }) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  function connectUpstox() {
    const clientId = process.env.NEXT_PUBLIC_UPSTOX_CLIENT_ID;
    const redirectUri = process.env.NEXT_PUBLIC_UPSTOX_REDIRECT_URI;
    const url = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${session.user.id}`;
    window.location.href = url;
  }

  async function syncNow() {
    setSyncing(true); setMessage("");
    try {
      const res = await fetch("/api/upstox/sync", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) { setMessage(data.error || "Sync failed."); }
      else { setMessage(`Synced ${data.imported} trade(s) from today.`); onSynced(); }
    } catch (e) {
      setMessage("Could not reach the sync service.");
    }
    setSyncing(false);
  }

  return (
    <div className="content">
      <h2 className="section-title">Connect Upstox</h2>
      <div className="card broker-card">
        <div>
          <div className="broker-name">Upstox</div>
          <div className="broker-status">Tap Connect, log in on Upstox's page, then come back here.</div>
        </div>
        <button className="pill" onClick={connectUpstox}>Connect</button>
      </div>
      <div className="muted-note">Upstox access tokens expire roughly every 24 hours — you may need to tap Connect again once a day to keep syncing.</div>

      <h2 className="section-title" style={{ marginTop: 20 }}>Sync today's trades</h2>
      <div className="card">
        <div className="muted-note" style={{ marginTop: 0 }}>Pulls today's executed trades from Upstox and adds them to your journal automatically.</div>
        <button className="primary" disabled={syncing} onClick={syncNow}>{syncing ? "Syncing..." : "Sync now"}</button>
        {message && <div className="muted-note">{message}</div>}
      </div>
    </div>
  );
}
