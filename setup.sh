#!/usr/bin/env bash
# Vibe Trade — one-command setup for Mac/Linux/Git Bash
# Usage:  bash setup.sh

set -e

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Vibe Trade — Setup Script          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# ─── Check prerequisites ───
echo -e "${YELLOW}→ Checking prerequisites...${NC}"

# Python
if command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
elif command -v python &> /dev/null; then
    PYTHON_CMD=python
else
    echo -e "${RED}✗ Python 3.12+ not found.${NC}"
    echo "  Install from: https://www.python.org/downloads/"
    exit 1
fi
PY_VERSION=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
echo -e "${GREEN}✓ Python $PY_VERSION${NC}"

# Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js 20+ not found.${NC}"
    echo "  Install from: https://nodejs.org/"
    exit 1
fi
NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js $NODE_VERSION${NC}"

# npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found (should come with Node.js).${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

echo ""

# ─── Set up .env ───
echo -e "${YELLOW}→ Setting up .env...${NC}"
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✓ Created .env from .env.example${NC}"
        echo -e "${YELLOW}  ⚠ You MUST edit .env and add your OPENAI_API_KEY before running${NC}"
    else
        echo "OPENAI_API_KEY=sk-..." > .env
        echo -e "${GREEN}✓ Created blank .env${NC}"
        echo -e "${YELLOW}  ⚠ You MUST edit .env and add your OPENAI_API_KEY before running${NC}"
    fi
else
    echo -e "${GREEN}✓ .env already exists${NC}"
fi

echo ""

# ─── Python venv + install ───
echo -e "${YELLOW}→ Setting up Python virtual environment...${NC}"
if [ ! -d venv ]; then
    $PYTHON_CMD -m venv venv
    echo -e "${GREEN}✓ Created venv/${NC}"
else
    echo -e "${GREEN}✓ venv/ already exists${NC}"
fi

# Activate venv (works on Mac/Linux and Git Bash on Windows)
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
    source venv/Scripts/activate
else
    echo -e "${RED}✗ Could not find venv activation script.${NC}"
    exit 1
fi

echo -e "${YELLOW}→ Installing Python dependencies (this may take a minute)...${NC}"
pip install --quiet --upgrade pip
pip install --quiet -r services/api/requirements.txt
echo -e "${GREEN}✓ Python dependencies installed${NC}"

echo ""

# ─── Frontend install ───
echo -e "${YELLOW}→ Installing frontend dependencies (this may take a minute)...${NC}"
cd apps/web
npm install --silent
cd ../..
echo -e "${GREEN}✓ Frontend dependencies installed${NC}"

echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           Setup Complete! 🎉           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo -e "1. Edit ${GREEN}.env${NC} and set your ${GREEN}OPENAI_API_KEY${NC}"
echo -e "   Get a key from: https://platform.openai.com/api-keys"
echo ""
echo -e "2. Start the backend (in this terminal):"
echo -e "   ${GREEN}source venv/bin/activate${NC}  (if not already activated)"
echo -e "   ${GREEN}python -m uvicorn services.api.main:app --reload --port 8000${NC}"
echo ""
echo -e "3. Start the frontend (in a ${YELLOW}new${NC} terminal):"
echo -e "   ${GREEN}cd apps/web${NC}"
echo -e "   ${GREEN}npm run dev${NC}"
echo ""
echo -e "4. Open ${GREEN}http://localhost:3000${NC} in your browser"
echo ""
