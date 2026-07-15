# Deploying TradeLedger — step by step

You already have: GitHub, Supabase, Vercel accounts, database tables created,
and your Upstox API key + secret. Here's the rest.

## 1. Get an OpenAI API key (powers the AI review + backtest features)
1. Go to platform.openai.com → sign up / log in (use your existing paid account)
2. Go to Dashboard → API Keys → Create new secret key
3. Copy the key (starts with `sk-...`) — you'll paste it into Vercel soon.
   Usage here is very light — a few cents per AI review/backtest, billed to
   your existing OpenAI account.

## 2. Get the code onto GitHub
Easiest way if you're not comfortable with code: install **GitHub Desktop**
(desktop.github.com).
1. Open GitHub Desktop, sign in with your GitHub account
2. File → Clone Repository → choose the `trade-ledger` repo you created
3. It'll clone to a folder on your computer — open that folder
4. Unzip the file I gave you, and copy ALL of its contents into that folder
   (so `package.json`, the `app` folder, etc. sit directly inside it)
5. Go back to GitHub Desktop — it will show all the new files as changes
6. Type a commit message like "Initial app", click "Commit to main"
7. Click "Push origin" (top right)

## 3. Deploy on Vercel
1. Go to vercel.com/new
2. Under "Import Git Repository", find and select `trade-ledger`, click Import
3. Before clicking Deploy, open "Environment Variables" and add each of these
   (names must match exactly, values are the ones you collected):

   | Name | Value |
   |---|---|
   | NEXT_PUBLIC_SUPABASE_URL | your Supabase Project URL |
   | NEXT_PUBLIC_SUPABASE_ANON_KEY | your Supabase Publishable key |
   | SUPABASE_SECRET_KEY | your Supabase Secret key |
   | NEXT_PUBLIC_UPSTOX_CLIENT_ID | your Upstox API Key |
   | UPSTOX_API_SECRET | your Upstox API Secret |
   | NEXT_PUBLIC_UPSTOX_REDIRECT_URI | leave blank for now, we'll fix after first deploy |
   | OPENAI_API_KEY | your OpenAI API key |
   | NEXT_PUBLIC_APP_URL | leave blank for now, we'll fix after first deploy |

4. Click **Deploy**. Wait ~2 minutes.
5. Once deployed, Vercel shows you your live URL, something like
   `https://trade-ledger-yourname.vercel.app`

## 4. Fix the two "leave blank for now" values
1. In Vercel: Project → Settings → Environment Variables
2. Edit `NEXT_PUBLIC_APP_URL` → set it to your real URL, e.g.
   `https://trade-ledger-yourname.vercel.app` (no trailing slash)
3. Edit `NEXT_PUBLIC_UPSTOX_REDIRECT_URI` → set it to
   `https://trade-ledger-yourname.vercel.app/api/upstox/callback`
4. Go to the "Deployments" tab → click the "..." menu on the latest deployment
   → **Redeploy** (env var changes need a redeploy to take effect)

## 5. Update the Upstox redirect URI to match
1. Go back to account.upstox.com/developer/apps
2. Open your TradeLedger app → Edit
3. Set Redirect URI to exactly:
   `https://trade-ledger-yourname.vercel.app/api/upstox/callback`
4. Save

## 6. Use it on your phone
1. Open your live URL in your phone's browser
2. Sign up with an email + password
3. Android (Chrome): menu (⋮) → "Add to Home screen"
   iPhone (Safari): Share icon → "Add to Home Screen"
4. It now opens like an app, full screen, from your home screen

## Notes / limits of this version
- Upstox access tokens expire roughly every 24 hours — tap **Connect** again
  each trading day before syncing.
- Auto-sync currently pulls **today's** executed trades and pairs buys with
  sells to build round-trip trades. Multi-day swing trades aren't paired yet.
- If something breaks after a deploy, Vercel's "Deployments" tab shows build
  logs — paste any red error text back to me and I'll fix it.
