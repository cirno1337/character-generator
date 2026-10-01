#!/usr/bin/env bash
# Start the character generator.  ./run.sh [--llm]
#   --llm   also start Gemma 4 (llama-start.sh) in the background if it is not running
set -euo pipefail
cd "$(dirname "$0")"

LLAMA_URL="${LLAMA_URL:-http://127.0.0.1:8081}"
LLAMA_START="${LLAMA_START:-$HOME/.local/bin/llama-start.sh}"
export LLAMA_URL

if curl -sf -m 3 "$LLAMA_URL/health" >/dev/null 2>&1; then
  echo "🟢 Gemma 4 działa na $LLAMA_URL"
elif [[ "${1:-}" == "--llm" ]]; then
  echo "🟡 Uruchamiam Gemma 4 w tle ($LLAMA_START) – log: data/llama.log"
  mkdir -p data
  nohup "$LLAMA_START" >data/llama.log 2>&1 &
else
  echo "🔴 Gemma 4 nie odpowiada na $LLAMA_URL"
  echo "   Uruchom w osobnym terminalu:  $LLAMA_START"
  echo "   albo:                         ./run.sh --llm"
fi

exec python3 server.py
