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
// Indian financial year runs April 1 - March 31. Returns e.g. "2025-26".
function financialYearOf(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // month 3 = April
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}
function currentFinancialYear() {
  return financialYearOf(new Date().toISOString());
}
function fyBounds(fyLabel) {
  const startYear = parseInt(fyLabel.split("-")[0], 10);
  return { start: new Date(startYear, 3, 1), end: new Date(startYear + 1, 2, 31, 23, 59, 59) };
}
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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
      {tab === "tax" && <TaxReportTab trades={trades} />}
      {tab === "auto" && <AutoTradeTab session={session} />}
      {tab === "broker" && <BrokerTab session={session} onSynced={loadAll} />}

      <div className="bottom-nav">
        {[
          ["journal", "📓", "Journal"],
          ["guardrails", "🛡️", "Guardrails"],
          ["analytics", "📊", "Analytics"],
          ["backtest", "🧪", "Backtest"],
          ["tax", "🧾", "Tax"],
          ["auto", "🤖", "Auto"],
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
  const [segment, setSegment] = useState("equity_intraday");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [qty, setQty] = useState("");
  const [time, setTime] = useState(() => new Date().toISOString().slice(0, 16));
  const [exitDate, setExitDate] = useState("");
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
      qty: q, entry_time: new Date(time).toISOString(),
      exit_time: exitDate ? new Date(exitDate).toISOString() : new Date(time).toISOString(),
      notes, pnl, source: "manual", segment,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setInstrument(""); setEntryPrice(""); setExitPrice(""); setQty(""); setNotes(""); setConfirmBreach(false); setExitDate("");
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
        <div className="field">
          <label>Segment (for tax classification)</label>
          <select value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="equity_intraday">Equity — Intraday</option>
            <option value="equity_delivery">Equity — Delivery</option>
            <option value="futures">Futures</option>
            <option value="options">Options</option>
          </select>
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
        {segment === "equity_delivery" && (
          <div className="field">
            <label>Exit date (if different from entry — affects short vs long-term tax)</label>
            <input type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
          </div>
        )}
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
      if (data.error) {
        setOutput(`<div class="banner danger">AI service error: ${data.error}</div>`);
        setLoading(false);
        return;
      }
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
      if (data.error) {
        setOutput(`<div class="banner danger">AI service error: ${data.error}</div>`);
        setLoading(false);
        return;
      }
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

// ---------- TAX REPORT TAB ----------
// Rates below reflect FY 2025-26 / AY 2026-27 as confirmed post Union Budget 2026.
// STCG (equity, Sec 111A): 20% flat, no exemption.
// LTCG (equity, held > 12 months): 12.5% on gains above Rs 1,25,000/year, no indexation.
// Speculative business income (equity intraday) and non-speculative (F&O) are taxed
// at the trader's income slab rate, not a flat rate - so we show net profit/loss only.
// Tax audit trigger (Sec 44AB, simplified): F&O turnover > Rs 10 crore, OR profit < 6%
// of turnover while total income exceeds the basic exemption limit.
const STCG_RATE = 0.20;
const LTCG_RATE = 0.125;
const LTCG_EXEMPTION = 125000;
const CESS_RATE = 0.04;

function TaxReportTab({ trades }) {
  const availableFYs = Array.from(new Set(trades.map((t) => financialYearOf(t.entry_time)))).sort().reverse();
  const [fy, setFy] = useState(availableFYs[0] || currentFinancialYear());
  const { start, end } = fyBounds(fy);
  const fyTrades = trades.filter((t) => {
    const d = new Date(t.entry_time);
    return d >= start && d <= end;
  });

  const speculative = fyTrades.filter((t) => t.segment === "equity_intraday");
  const fno = fyTrades.filter((t) => t.segment === "futures" || t.segment === "options");
  const delivery = fyTrades.filter((t) => t.segment === "equity_delivery");

  const speculativePnl = speculative.reduce((s, t) => s + t.pnl, 0);
  const fnoPnl = fno.reduce((s, t) => s + t.pnl, 0);
  const fnoTurnover = fno.reduce((s, t) => s + Math.abs(t.pnl), 0);
  const auditFlag = fnoTurnover > 100000000 || (fnoTurnover > 0 && fnoPnl < fnoTurnover * 0.06);

  let stcgTotal = 0, ltcgTotal = 0;
  delivery.forEach((t) => {
    const exit = t.exit_time ? new Date(t.exit_time) : new Date(t.entry_time);
    const entry = new Date(t.entry_time);
    const holdingDays = (exit - entry) / (1000 * 60 * 60 * 24);
    if (holdingDays > 365) ltcgTotal += t.pnl; else stcgTotal += t.pnl;
  });
  const stcgTax = stcgTotal > 0 ? stcgTotal * STCG_RATE : 0;
  const ltcgTaxable = Math.max(0, ltcgTotal - LTCG_EXEMPTION);
  const ltcgTax = ltcgTaxable * LTCG_RATE;
  const capGainsCess = (stcgTax + ltcgTax) * CESS_RATE;

  function exportCsv() {
    const rows = [["Date", "Instrument", "Segment", "Side", "Qty", "Entry Price", "Exit Price", "P&L", "Source"]];
    fyTrades.forEach((t) => {
      rows.push([new Date(t.entry_time).toLocaleDateString("en-IN"), t.instrument, t.segment, t.side, t.qty, t.entry_price, t.exit_price, t.pnl.toFixed(2), t.source]);
    });
    downloadCsv(`tradeledger-tax-fy${fy}.csv`, rows);
  }

  return (
    <div className="content">
      <div className="banner warn">This is a simplified estimate for planning purposes only, based on rates for FY 2025-26 (AY 2026-27). It is not tax advice. Please confirm final figures with a Chartered Accountant before filing, especially for audit applicability and loss carry-forward.</div>

      <div className="week-nav">
        <span className="week-label">Financial Year</span>
        <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: "auto" }}>
          {(availableFYs.length ? availableFYs : [currentFinancialYear()]).map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <h2 className="section-title">Speculative business income (equity intraday)</h2>
      <div className="card">
        <div className="row">
          <div><div className="trade-meta">Trades</div><div className="pnl">{speculative.length}</div></div>
          <div><div className="trade-meta">Net P&L</div><div className={"pnl " + (speculativePnl >= 0 ? "pos" : "neg")}>{fmt(speculativePnl)}</div></div>
        </div>
        <div className="muted-note">Taxed at your income slab rate. Losses can only be set off against other speculative income, and carried forward up to 4 years.</div>
      </div>

      <h2 className="section-title">Non-speculative business income (F&O)</h2>
      <div className="card">
        <div className="row">
          <div><div className="trade-meta">Trades</div><div className="pnl">{fno.length}</div></div>
          <div><div className="trade-meta">Net P&L</div><div className={"pnl " + (fnoPnl >= 0 ? "pos" : "neg")}>{fmt(fnoPnl)}</div></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div><div className="trade-meta">Turnover (audit basis)</div><div className="pnl">{fmt(fnoTurnover)}</div></div>
          <div><div className="trade-meta">Audit likely required</div><div className="pnl" style={{ color: auditFlag ? "var(--loss)" : "var(--profit)" }}>{auditFlag ? "Yes" : "No"}</div></div>
        </div>
        <div className="muted-note">Taxed at your income slab rate. Losses can be set off against most other income (except salary), carried forward up to 8 years. Audit trigger: turnover over ₹10 crore, or profit under 6% of turnover.</div>
      </div>

      <h2 className="section-title">Capital gains (equity delivery)</h2>
      <div className="card">
        <div className="stat-grid">
          <div className="stat-box"><div className="label">STCG (≤12mo)</div><div className="value" style={{ color: stcgTotal >= 0 ? "var(--profit)" : "var(--loss)" }}>{fmt(stcgTotal)}</div></div>
          <div className="stat-box"><div className="label">STCG tax (20%)</div><div className="value">{fmt(stcgTax)}</div></div>
          <div className="stat-box"><div className="label">LTCG (&gt;12mo)</div><div className="value" style={{ color: ltcgTotal >= 0 ? "var(--profit)" : "var(--loss)" }}>{fmt(ltcgTotal)}</div></div>
          <div className="stat-box"><div className="label">LTCG tax (12.5% over ₹1.25L)</div><div className="value">{fmt(ltcgTax)}</div></div>
        </div>
        <div className="muted-note">Estimated cess (4%) on capital gains tax: {fmt(capGainsCess)}. Estimated total capital gains tax + cess: {fmt(stcgTax + ltcgTax + capGainsCess)}.</div>
        <div className="muted-note">Holding period is based on entry/exit dates logged in your journal. Multi-day delivery positions synced automatically from your broker may not capture the true original purchase date — double check these manually.</div>
      </div>

      <button className="ghost" onClick={exportCsv}>Download this FY's trades as CSV (for your CA)</button>
    </div>
  );
}


// ---------- AUTO-TRADE TAB (paper trading only) ----------
function AutoTradeTab({ session }) {
  const user = session.user;
  const [strategies, setStrategies] = useState([]);
  const [paperTrades, setPaperTrades] = useState([]);
  const [description, setDescription] = useState("");
  const [instrumentKey, setInstrumentKey] = useState("NSE_INDEX|Nifty 50");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [draft, setDraft] = useState(null); // parsed rules pending confirmation
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    const { data: s } = await supabase.from("strategies").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    setStrategies(s || []);
    const { data: pt } = await supabase.from("paper_trades").select("*").eq("user_id", user.id).order("entry_time", { ascending: false });
    setPaperTrades(pt || []);
  }

  async function parseStrategy() {
    setParseError(""); setDraft(null);
    if (!description.trim()) { setParseError("Describe your strategy first."); return; }
    setParsing(true);
    try {
      const res = await fetch("/api/strategy/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description }) });
      const data = await res.json();
      console.log("strategy parse response:", data);
      if (!res.ok) { setParseError(`Server error (${res.status}). Check the browser console for details.`); setParsing(false); return; }
      if (data.error) { setParseError(data.error); setParsing(false); return; }
      if (!data.rules || !Array.isArray(data.rules.entry_conditions)) {
        setParseError("The AI response didn't match the expected format. Check the browser console (F12) for the raw response and share it.");
        setParsing(false);
        return;
      }
      setDraft({
        direction: data.rules.direction || "long",
        entry_conditions: data.rules.entry_conditions || [],
        window_start: data.rules.window_start || "09:15",
        window_end: data.rules.window_end || "15:15",
        stop_loss_type: data.rules.stop_loss_type || "percent",
        stop_loss_value: data.rules.stop_loss_value ?? 0.5,
        stop_loss_metric: data.rules.stop_loss_metric || "",
        target_type: data.rules.target_type || "percent",
        target_value: data.rules.target_value ?? 1,
        max_risk_points: data.rules.max_risk_points ?? null,
        qty: data.rules.qty || 1,
        summary: data.rules.summary || "",
      });
    } catch (e) {
      console.error("strategy parse error:", e);
      setParseError("Could not reach the parsing service. Check the browser console for details.");
    }
    setParsing(false);
  }

  async function saveStrategy(armed) {
    setSaving(true);
    await supabase.from("strategies").insert({
      user_id: user.id, name: description.slice(0, 60), description,
      instrument_key: instrumentKey, direction: draft.direction,
      entry_conditions: draft.entry_conditions, window_start: draft.window_start, window_end: draft.window_end,
      stop_loss_type: draft.stop_loss_type, stop_loss_value: draft.stop_loss_value, stop_loss_metric: draft.stop_loss_metric,
      target_type: draft.target_type, target_value: draft.target_value, max_risk_points: draft.max_risk_points,
      qty: draft.qty, active: armed,
    });
    setSaving(false);
    setDescription(""); setDraft(null);
    load();
  }

  function updateCondition(i, patch) {
    const conds = [...draft.entry_conditions];
    conds[i] = { ...conds[i], ...patch };
    setDraft({ ...draft, entry_conditions: conds });
  }
  function addCondition() {
    setDraft({ ...draft, entry_conditions: [...draft.entry_conditions, { metric: "price", comparator: "above", value_type: "metric", value: "vwap" }] });
  }
  function removeCondition(i) {
    setDraft({ ...draft, entry_conditions: draft.entry_conditions.filter((_, idx) => idx !== i) });
  }

  async function toggleActive(s) {
    await supabase.from("strategies").update({ active: !s.active }).eq("id", s.id);
    load();
  }

  async function deleteStrategy(id) {
    await supabase.from("strategies").delete().eq("id", id);
    load();
  }

  return (
    <div className="content">
      <div className="banner warn">Paper trading only — no real orders are ever placed here. This simulates your strategy against live prices so you can see how it would have performed before risking real money. Requires an external scheduler hitting the engine every few minutes during market hours (see setup notes from your developer). Not investment advice.</div>

      <h2 className="section-title">Define a strategy</h2>
      <div className="card">
        <div className="field">
          <label>Instrument key</label>
          <input value={instrumentKey} onChange={(e) => setInstrumentKey(e.target.value)} placeholder="e.g. NSE_INDEX|Nifty 50" />
          <div className="muted-note">Use "NSE_INDEX|Nifty 50" or "NSE_INDEX|Nifty Bank" for indices. For individual stocks, ask your developer to look up the exact instrument key from Upstox's instrument master file.</div>
        </div>
        <div className="field">
          <label>Describe your strategy in plain English</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Buy NIFTY if it breaks above yesterday's high before 10am, stop loss 0.5%, target 1%, quantity 50" />
        </div>
        {parseError && <div className="error-text">{parseError}</div>}
        <button className="primary" disabled={parsing} onClick={parseStrategy}>{parsing ? "Parsing..." : "Parse with AI"}</button>

        {draft && (
          <div className="card" style={{ marginTop: 12, background: "var(--surface2)" }}>
            <div className="muted-note" style={{ marginTop: 0 }}>{draft.summary}</div>
            <div className="field">
              <label>Direction</label>
              <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value })}>
                <option value="long">Long</option><option value="short">Short</option>
              </select>
            </div>

            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Entry conditions (all must be true)</label>
            {draft.entry_conditions.map((c, i) => (
              <div className="card" key={i} style={{ padding: 10, marginBottom: 8, background: "var(--surface)" }}>
                <div className="row">
                  <div className="field">
                    <label>Metric</label>
                    <input value={c.metric} onChange={(e) => updateCondition(i, { metric: e.target.value })} placeholder="price, vwap, sma_20, rsi_14..." />
                  </div>
                  <div className="field">
                    <label>Comparator</label>
                    <select value={c.comparator} onChange={(e) => updateCondition(i, { comparator: e.target.value })}>
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                      <option value="crosses_above">Crosses above</option>
                      <option value="crosses_below">Crosses below</option>
                    </select>
                  </div>
                </div>
                <div className="row">
                  <div className="field">
                    <label>Compare to</label>
                    <select value={c.value_type} onChange={(e) => updateCondition(i, { value_type: e.target.value })}>
                      <option value="number">A number</option>
                      <option value="metric">Another metric</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Value</label>
                    <input value={c.value} onChange={(e) => updateCondition(i, { value: c.value_type === "number" ? parseFloat(e.target.value) : e.target.value })} placeholder={c.value_type === "number" ? "30" : "sma_20"} />
                  </div>
                </div>
                <button className="ghost" style={{ color: "var(--loss)" }} onClick={() => removeCondition(i)}>Remove condition</button>
              </div>
            ))}
            <button className="ghost" onClick={addCondition}>+ Add another condition</button>
            <div className="muted-note">Metrics: price, vwap, day_open, prev_day_high, prev_day_low, sma_N, ema_N, rsi_N (e.g. sma_20, ema_9, rsi_14)</div>

            <div className="row" style={{ marginTop: 10 }}>
              <div className="field"><label>Window start</label><input value={draft.window_start} onChange={(e) => setDraft({ ...draft, window_start: e.target.value })} /></div>
              <div className="field"><label>Window end</label><input value={draft.window_end} onChange={(e) => setDraft({ ...draft, window_end: e.target.value })} /></div>
            </div>

            <div className="field">
              <label>Stop-loss type</label>
              <select value={draft.stop_loss_type} onChange={(e) => setDraft({ ...draft, stop_loss_type: e.target.value })}>
                <option value="percent">Fixed percent from entry</option>
                <option value="candle_metric">A price level (e.g. previous candle's high/low)</option>
              </select>
            </div>
            {draft.stop_loss_type === "percent" ? (
              <div className="field"><label>Stop loss %</label><input type="number" step="0.1" value={draft.stop_loss_value} onChange={(e) => setDraft({ ...draft, stop_loss_value: parseFloat(e.target.value) })} /></div>
            ) : (
              <div className="field"><label>Stop-loss metric</label><input value={draft.stop_loss_metric || ""} onChange={(e) => setDraft({ ...draft, stop_loss_metric: e.target.value })} placeholder="prev_candle_high or prev_candle_low" /></div>
            )}

            <div className="field">
              <label>Target type</label>
              <select value={draft.target_type} onChange={(e) => setDraft({ ...draft, target_type: e.target.value })}>
                <option value="percent">Fixed percent from entry</option>
                <option value="r_multiple">Risk multiple (e.g. 5 = 1:5 risk:reward)</option>
              </select>
            </div>
            <div className="field">
              <label>{draft.target_type === "r_multiple" ? "Risk multiple" : "Target %"}</label>
              <input type="number" step="0.1" value={draft.target_value} onChange={(e) => setDraft({ ...draft, target_value: parseFloat(e.target.value) })} />
            </div>

            <div className="field">
              <label>Max risk in points (optional — skip trade if stop distance exceeds this)</label>
              <input type="number" value={draft.max_risk_points || ""} onChange={(e) => setDraft({ ...draft, max_risk_points: e.target.value ? parseFloat(e.target.value) : null })} placeholder="e.g. 25" />
            </div>

            <div className="field"><label>Quantity</label><input type="number" value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: parseFloat(e.target.value) })} /></div>
            <button className="primary" disabled={saving} onClick={() => saveStrategy(true)}>{saving ? "Saving..." : "Save & Arm (paper trading)"}</button>
            <button className="ghost" disabled={saving} onClick={() => saveStrategy(false)}>Save without arming</button>
          </div>
        )}
      </div>

      <h2 className="section-title">Your strategies</h2>
      {strategies.length === 0 ? (
        <div className="card"><div className="empty-state">No strategies yet. Define one above.</div></div>
      ) : (
        strategies.map((s) => {
          const trades = paperTrades.filter((t) => t.strategy_id === s.id);
          const closed = trades.filter((t) => t.status === "closed");
          const net = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
          const wins = closed.filter((t) => (t.pnl || 0) > 0).length;
          return (
            <div className="card" key={s.id}>
              <div className="row">
                <div>
                  <div className="trade-instr">{s.name}</div>
                  <div className="trade-meta">{s.instrument_key} · {s.direction} · {(s.entry_conditions || []).map((c) => `${c.metric} ${c.comparator.replace(/_/g, " ")} ${c.value}`).join(" AND ")}</div>
                </div>
                <button className="pill" style={{ color: s.active ? "var(--profit)" : "var(--muted)" }} onClick={() => toggleActive(s)}>
                  {s.active ? "Armed" : "Paused"}
                </button>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <div><div className="trade-meta">Paper trades</div><div className="pnl">{closed.length}</div></div>
                <div><div className="trade-meta">Win rate</div><div className="pnl">{closed.length ? Math.round((wins / closed.length) * 100) : 0}%</div></div>
                <div><div className="trade-meta">Net (simulated)</div><div className={"pnl " + (net >= 0 ? "pos" : "neg")}>{fmt(net)}</div></div>
              </div>
              <button className="ghost" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>{expanded === s.id ? "Hide trades" : "View trades"}</button>
              {expanded === s.id && (
                <div style={{ marginTop: 10 }}>
                  {trades.length === 0 ? <div className="muted-note">No paper trades logged yet.</div> : trades.map((t) => (
                    <div className="trade-row" key={t.id}>
                      <div>
                        <div className="trade-instr">{t.side === "buy" ? "Long" : "Short"} @ {t.entry_price}</div>
                        <div className="trade-meta">{new Date(t.entry_time).toLocaleString("en-IN")} {t.status === "closed" ? `→ ${t.exit_price}` : "(open)"}</div>
                      </div>
                      <div className={"pnl " + ((t.pnl || 0) >= 0 ? "pos" : "neg")}>{t.pnl != null ? fmt(t.pnl) : "—"}</div>
                    </div>
                  ))}
                </div>
              )}
              <button className="ghost" style={{ color: "var(--loss)", marginTop: 8 }} onClick={() => deleteStrategy(s.id)}>Delete strategy</button>
            </div>
          );
        })
      )}
    </div>
  );
}

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
