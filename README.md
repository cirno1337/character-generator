# Laboratorium Postaci – local AI character generator

A small local web app for designing fictional characters for novels, using the local
**Gemma 4 12B** model (llama.cpp). No external APIs and no dependencies beyond Python 3 (stdlib only).

## Start

```bash
# 1. model (if not running) – in a separate terminal
~/.local/bin/llama-start.sh

# 2. app
cd ~/Kucowansko/character-generator
./run.sh              # or: python3 server.py
./run.sh --llm        # also starts llama-start.sh in the background if the model is down
```

Open **http://127.0.0.1:8765**

Environment variables: `CG_PORT` (8765), `CG_HOST` (127.0.0.1), `LLAMA_URL` (http://127.0.0.1:8081).

## How it works

```
browser (vanilla JS)                    server.py (stdlib)                  llama-server :8081
 ├─ character sheet {value, source}  →  POST /api/generate  ─────────────→  POST /v1/chat/completions
 ├─ randomization + coherence (JS)       ├─ builds system + user prompt        stream=true
 └─ rendering / export                   ├─ response_format: json_schema       enable_thinking=false
                                         └─ NDJSON stream (progress, done)  ←  SSE chunks
```

* **llama.cpp**: `llama-start.sh` runs `llama-server -hf unsloth/gemma-4-12b-it-GGUF:UD-Q4_K_XL`
  on `127.0.0.1:8081`, context 12288, `--jinja`. The app uses the OpenAI-compatible API:
  `GET /v1/models` (status + n_ctx) and `POST /v1/chat/completions` (streaming).
* **One request per character.** The JSON schema (`prompts.py`) is enforced by llama.cpp's grammar,
  so the output is always valid JSON with all 13 sections. If the server rejects `json_schema`, the app falls back to `json_object`;
  if JSON is still broken, truncated output is repaired, and as a last resort the raw text is shown as Markdown.
* **Gemma 4 "thinking" is disabled** (`chat_template_kwargs.enable_thinking=false`); otherwise it eats the token budget.
* Parameters: `temperature 0.8`, `top_p 0.95`, `max_tokens ≤ 7000` (capped by n_ctx). A generation takes about 70 s (~60 tok/s).

## Data model

Every field is `{value, source}`:

| source      | meaning                                   | UI  |
|-------------|-------------------------------------------|-----|
| `user`      | author's value – **locked**, never changed | 🔒 gold |
| `generated` | rolled / filled in by the model           | 🎲 violet, dashed |
| `unset`     | empty (`null`) – to be rolled             | ?   |

`0` and unset are distinct: the `0` button means "explicitly unimportant / absent".
Clicking your own value again clears it; the 🔒/🎲 icon toggles lock ↔ roll.

## Randomization (`static/randomizer.js`)

* Distributions: axes 1–5 `15/20/30/20/15 %`, traits 0–5 `5/15/25/30/20/5 %`, priorities slightly wider.
* **Prompt biases**: keywords in the description steer the distribution
  (e.g. "nie jest wojowniczką" → pacifist, low aggression; "nieśmiała" → shy/introverted; "spokojnym świecie" does *not* make the character calm).
* **Coherence pass**: 31 rules for contradictory pairs (introvert vs charisma, empathy vs malice…).
  Only generated values are corrected (prompt-biased ones take priority over plain random ones). With 30% probability
  one contradiction is kept on purpose. Contradictions that remain, especially ones you set yourself, go to the model as
  "Napięcia" (tensions) to be *explained*, not flattened.
* Empty basic fields (name, race…) are **not** rolled in JS – the model invents them to fit the world, and afterwards they
  appear in the form as 🎲.

Constraint hierarchy in the prompt: 🔒 fields → author's description → 🎲 values → model's creativity.

## Buttons

| | |
|---|---|
| 🎲 Losuj cechy | rolls only empty fields |
| 🔁 Losuj ponownie | rerolls everything that isn't 🔒 (also clears model-invented basic fields) |
| ♻️ Resetuj losowe | clears 🎲, keeps 🔒 |
| ✨ Generuj postać | fills empty fields and writes the character (Ctrl+Enter) |
| 🔄 Regeneruj opis | new interpretation of **exactly the same** sheet (no rolling) |
| 🎲 Przelosuj wartości | Losuj ponownie + generate |
| 📋 Kopiuj / ⬇ Markdown / ⬇ JSON | export (Markdown includes a sheet appendix, JSON includes `{value, source}`) |
| 💾 Zapisz / 📚 Zapisane | saved to `data/characters.json` |

The current sheet and result are also kept in `localStorage` (they survive a page reload).

## Files

```
character-generator/
├── run.sh                 start script (checks the model)
├── server.py              HTTP server: static files, /api/status, /api/generate, /api/characters
├── prompts.py             system prompt, sheet → prompt, JSON output schema
├── static/
│   ├── index.html
│   ├── style.css
│   ├── app.js             UI state, events, generation streaming, save/export
│   ├── randomizer.js      data model, distributions, prompt biases, coherence (pure, testable)
│   ├── render.js          character HTML rendering, Markdown export
│   └── fields.json        field definitions (shared by frontend and backend)
├── tests/
│   ├── randomizer.test.mjs   node --test tests/
│   ├── test_server.py        python3 -m unittest discover -s tests
│   └── fixtures/sample_character.json   real model response
└── data/                  saved characters (created automatically)
```

## Tests

```bash
node --test tests/
python3 -m unittest discover -s tests
```
