# Vibe Trade — one-command setup for Windows PowerShell
# Usage:  .\setup.ps1
#
# If you get a "cannot be loaded because running scripts is disabled" error, run:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

$ErrorActionPreference = "Stop"

function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Info    { param($msg) Write-Host "-> $msg" -ForegroundColor Yellow }
function Write-Err     { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }
function Write-Header  { param($msg) Write-Host $msg -ForegroundColor Cyan }

Write-Header "========================================"
Write-Header "      Vibe Trade - Setup Script         "
Write-Header "========================================"
Write-Host ""

# --- Check prerequisites ---
Write-Info "Checking prerequisites..."

# Python
$pythonCmd = $null
foreach ($cmd in @("python", "py", "python3")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $pythonCmd = $cmd
        break
    }
}
if (-not $pythonCmd) {
    Write-Err "Python 3.12+ not found."
    Write-Host "  Install from: https://www.python.org/downloads/"
    Write-Host "  IMPORTANT: Check 'Add Python to PATH' during install."
    exit 1
}
$pyVersion = & $pythonCmd --version 2>&1
Write-Success "$pyVersion (using '$pythonCmd' command)"

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "Node.js 20+ not found."
    Write-Host "  Install from: https://nodejs.org/"
    exit 1
}
$nodeVersion = node --version
Write-Success "Node.js $nodeVersion"

# npm
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Err "npm not found (should come with Node.js)."
    exit 1
}
$npmVersion = npm --version
Write-Success "npm $npmVersion"

Write-Host ""

# --- Set up .env ---
Write-Info "Setting up .env..."
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Success "Created .env from .env.example"
    } else {
        "OPENAI_API_KEY=sk-..." | Out-File -FilePath ".env" -Encoding utf8
        Write-Success "Created blank .env"
    }
    Write-Host "  WARN: You MUST edit .env and add your OPENAI_API_KEY before running" -ForegroundColor Yellow
} else {
    Write-Success ".env already exists"
}

Write-Host ""

# --- Python venv + install ---
Write-Info "Setting up Python virtual environment..."
if (-not (Test-Path "venv")) {
    & $pythonCmd -m venv venv
    Write-Success "Created venv/"
} else {
    Write-Success "venv/ already exists"
}

# Activate venv
$activateScript = ".\venv\Scripts\Activate.ps1"
if (-not (Test-Path $activateScript)) {
    Write-Err "Could not find venv activation script at $activateScript"
    exit 1
}
& $activateScript

Write-Info "Installing Python dependencies (this may take a minute)..."
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r services/api/requirements.txt
Write-Success "Python dependencies installed"

Write-Host ""

# --- Frontend install ---
Write-Info "Installing frontend dependencies (this may take a minute)..."
Push-Location apps/web
npm install --silent
Pop-Location
Write-Success "Frontend dependencies installed"

Write-Host ""
Write-Header "========================================"
Write-Header "           Setup Complete!              "
Write-Header "========================================"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Edit " -NoNewline
Write-Host ".env" -ForegroundColor Green -NoNewline
Write-Host " and set your " -NoNewline
Write-Host "OPENAI_API_KEY" -ForegroundColor Green
Write-Host "   Get a key from: https://platform.openai.com/api-keys"
Write-Host ""
Write-Host "2. Start the backend (in this terminal):"
Write-Host "   .\venv\Scripts\Activate.ps1  (if not already activated)" -ForegroundColor Green
Write-Host "   python -m uvicorn services.api.main:app --reload --port 8000" -ForegroundColor Green
Write-Host ""
Write-Host "3. Start the frontend (in a NEW terminal):"
Write-Host "   cd apps\web" -ForegroundColor Green
Write-Host "   npm run dev" -ForegroundColor Green
Write-Host ""
Write-Host "4. Open " -NoNewline
Write-Host "http://localhost:3000" -ForegroundColor Green -NoNewline
Write-Host " in your browser"
Write-Host ""
