#!/bin/bash
# ============================================================
# BuildCast — GitHub + Railway Setup Script
# Run this in Git Bash from the BuildCast folder
# ============================================================

echo ""
echo "======================================"
echo "  BUILDCAST SETUP"
echo "======================================"
echo ""

# ── STEP 1: Check we're in the right folder ──────────────
if [ ! -f "buildcast.html" ]; then
  echo "❌ ERROR: Run this script from the 'Construction Video app' folder."
  echo "   cd to the folder that contains buildcast.html, then run: bash setup.sh"
  exit 1
fi

echo "✅ Found buildcast.html — you're in the right folder."
echo "📁 Project path: $(pwd)"
echo ""

# ── STEP 2: Git init ─────────────────────────────────────
echo "--- Initializing git repo ---"
git init
git add .
git commit -m "Initial commit: BuildCast — Construction Content Studio"
echo ""

# ── STEP 3: Install GitHub CLI if missing ────────────────
if ! command -v gh &> /dev/null; then
  echo "--- Installing GitHub CLI ---"
  winget install --id GitHub.cli -e
  echo "⚠  GitHub CLI installed. Close and reopen Git Bash, then run this script again."
  exit 0
fi

echo "✅ GitHub CLI found."

# ── STEP 4: GitHub auth check ────────────────────────────
if ! gh auth status &> /dev/null; then
  echo ""
  echo "--- Logging into GitHub ---"
  echo "👉 A browser window will open. Log in and authorize the CLI."
  gh auth login
fi

echo "✅ GitHub authenticated."
echo ""

# ── STEP 5: Create GitHub repo and push ──────────────────
echo "--- Creating GitHub repo 'buildcast' ---"
gh repo create buildcast --public --source=. --remote=origin --push
echo ""
echo "✅ Pushed to GitHub."
REPO_URL=$(gh repo view --json url -q .url)
echo "🔗 Repo: $REPO_URL"
echo ""

# ── STEP 6: Railway CLI check ────────────────────────────
if ! command -v railway &> /dev/null; then
  echo "--- Installing Railway CLI ---"
  npm install -g @railway/cli
fi

echo "✅ Railway CLI found."
echo ""

# ── STEP 7: Railway login ────────────────────────────────
echo "--- Logging into Railway (browser will open) ---"
railway login
echo ""

# ── STEP 8: Deploy to Railway ────────────────────────────
echo "--- Creating Railway project and deploying ---"
railway init --name buildcast
railway up

echo ""
echo "======================================"
echo "  ✅ BUILDCAST IS LIVE!"
echo "======================================"
echo ""
echo "🚀 Your Railway URL will appear above."
echo "📤 Share that URL with your teammate."
echo ""
