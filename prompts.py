"""Prompt construction and output schema for character generation.

The system prompt stays on the server and is never sent to the browser.
"""

import json
from pathlib import Path

FIELDS = json.loads((Path(__file__).parent / "static" / "fields.json").read_text(encoding="utf-8"))

LEVEL_WORDS = ["brak / znikome", "bardzo niskie", "niskie", "umiarkowane", "wysokie", "bardzo wysokie"]
PRIORITY_WORDS = ["zupełnie nieważne", "mało ważne", "raczej mało ważne", "średnio ważne", "bardzo ważne", "najważniejsze w życiu"]

SYSTEM_PROMPT = """You are an expert fiction writer and psychological character designer helping a novelist.
You turn a structured character sheet into a believable, specific human being (or non-human person) — not a list of adjectives.

WRITE EVERYTHING IN POLISH. Natural, literary but clear Polish. No English words unless they are names.

PRIORITY OF CONSTRAINTS (higher wins on conflict):
1. Values marked [AUTOR] — chosen by the author. Hard constraints. Never contradict them. Basic data marked [AUTOR] must be copied exactly into "dane_podstawowe".
2. The author's free-form description (world, genre, role, explicit statements like "nie jest wojowniczką"). Hard constraints.
3. Values marked [LOSOWE] — random suggestions. Follow them, but interpret them within the world and the description. A high risk-taking score in a quiet teacher means small everyday risks, not a secret assassin.
4. Your own creative interpretation.

HOW TO READ THE SHEET:
- Scales 0–5: 0 = explicitly absent, 5 = very strong. Axes 1–5 between two poles: 1 = strongly left pole, 3 = balanced, 5 = strongly right pole.
- Numbers must show up as behaviour, habits, choices and voice. Never mention the numbers or the sheet itself.
- Basic data marked [DO USTALENIA] is yours to invent so it fits the world and the description; put the result in "dane_podstawowe". Birthdays should fit the world's calendar if it has one.
- "Napięcia" lists contradictory combinations. Do NOT flatten them. Explain them psychologically (context-dependence, masks, history, defense mechanisms), e.g. reserved with strangers but talkative with trusted people.

QUALITY RULES:
- Aim for: believable + interesting + internally coherent + imperfect.
- Strengths should be able to become weaknesses and vice versa. Give conflicting desires, things they hide, things they misunderstand about themselves.
- Be concrete: names of places, people, objects, foods, habits. Prefer a specific detail over a general statement.
- AVOID clichés: "mysterious with a dark past", default trauma, default sarcasm, secretly overpowered, genius-level intelligence, edgy one-liners, morally-grey-by-default. Use trauma only if the sheet or description really points to it. Characters must vary.
- NAMES: invent names that fit the world's culture and language (Slavic-sounding worlds get Slavic names, etc.). Never use overused AI-fantasy names: Elara, Lyra, Lirael, Aria, Seraphina, Kael, Kaelen, Thorne, Vane, Blackwood, Ashford, Nightshade, Silverleaf, Eldrin.
- Mundane details matter: what they do on a boring Tuesday.
- Boundary situations: mix small everyday tests with bigger ones; not all melodramatic. Give 4–6.
- Character arc: do not force a happy ending.
- Dialogue lines: 5 lines in the character's real voice. At least 3 must be ordinary, unpolished speech (a request, a complaint, small talk, a joke, hesitation) – not aphorisms or speeches.
- Characteristic details: 5–10, small and grounded.

LENGTH: rich but disciplined. Most text fields 2–5 sentences. Lists of 3–6 items unless specified. The whole answer should fit in about 3500 words.

OUTPUT: a single JSON object matching the provided schema. No text outside the JSON."""


def _s(desc: str) -> dict:
    return {"type": "string", "description": desc}


def _arr(items: dict, lo: int, hi: int) -> dict:
    return {"type": "array", "items": items, "minItems": lo, "maxItems": hi}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


OUTPUT_SCHEMA = _obj({
    "dane_podstawowe": _obj({
        "imie_nazwisko": _s("Imię/nazwisko"),
        "rasa": _s("Rasa"),
        "urodziny": _s("Urodziny"),
        "klasa": _s("Klasa / zajęcie"),
        "plec": _s("Płeć"),
        "wzrost": _s("Wzrost"),
        "podklasa": _s("Podklasa / specjalizacja"),
    }),
    "koncepcja": _s("2–4 zdania: kim jest i co od razu czyni tę postać interesującą"),
    "motywacja": _obj({
        "czego_chce": _s("centralna motywacja"),
        "dlaczego": _s("skąd to pragnienie"),
        "co_poswieci": _s("co jest gotowa poświęcić"),
        "czego_boi_sie_stracic": _s("czego boi się stracić"),
    }),
    "przeszlosc": _obj({
        "dziecinstwo_i_rodzina": _s("dzieciństwo, rodzina"),
        "edukacja": _s("edukacja, nauka, mistrzowie"),
        "wazne_relacje": _s("ważne relacje z przeszłości"),
        "sukcesy_i_porazki": _s("sukcesy i porażki"),
        "wydarzenia_ksztaltujace": _arr(_obj({
            "wydarzenie": _s("co się stało"),
            "wplyw": _s("jak to ukształtowało obecną osobowość"),
        }), 1, 4),
    }),
    "osobowosc": _obj({
        "zachowanie": _s("jak się zachowuje"),
        "myslenie": _s("jak myśli"),
        "sposob_mowienia": _s("jak mówi: rytm, słownictwo, nawyki językowe"),
        "wobec_obcych": _s("wobec obcych"),
        "wobec_przyjaciol": _s("wobec przyjaciół"),
        "pod_presja": _s("pod presją"),
        "mocne_strony": _arr(_s("mocna strona"), 3, 6),
        "slabosci": _arr(_s("słabość"), 3, 6),
        "sprzecznosci": _arr(_s("sprzeczność i jej psychologiczne wyjaśnienie"), 1, 4),
    }),
    "swiatopoglad": _arr(_obj({
        "temat": _s("np. moralność, władza, pieniądze, sprawiedliwość, religia"),
        "poglad": _s("co myśli i dlaczego"),
    }), 3, 7),
    "pasje": _arr(_obj({
        "nazwa": _s("pasja / zainteresowanie"),
        "opis": _s("jak to wygląda w praktyce"),
    }), 3, 6),
    "relacje": _arr(_obj({
        "z_kim": _s("rodzina / przyjaciele / miłość / autorytety / wrogowie / obcy"),
        "wzorzec": _s("wzorzec zachowań w tych relacjach"),
    }), 4, 6),
    "codziennosc": _s("zwykły dzień z drobnymi przyziemnymi szczegółami (4–8 zdań)"),
    "sytuacje_graniczne": _arr(_obj({
        "sytuacja": _s("sytuacja"),
        "reakcja": _s("pierwsza reakcja"),
        "decyzja": _s("decyzja"),
        "konsekwencja": _s("konsekwencja"),
        "co_ujawnia": _s("co to ujawnia o postaci"),
    }), 4, 6),
    "konflikt_wewnetrzny": _obj({
        "przekonanie_o_sobie": _s("co myśli o sobie"),
        "prawda": _s("jak jest naprawdę"),
        "czego_chce": _s("czego chce"),
        "czego_potrzebuje": _s("czego naprawdę potrzebuje"),
    }),
    "rozwoj": _obj({
        "mozliwy_luk": _s("możliwy łuk postaci"),
        "co_moze_zmienic": _s("co mogłoby ją zmienić"),
        "czego_moze_sie_nauczyc": _s("czego może się nauczyć"),
        "co_moze_zlamac": _s("co mogłoby ją złamać"),
        "co_wzmocni": _s("co może ją wzmocnić"),
        "czego_nie_zmieni": _s("czego odmówi zmiany"),
    }),
    "detale": _arr(_s("charakterystyczny drobny detal"), 5, 10),
    "wypowiedzi": _arr(_obj({
        "kontekst": _s("krótko: w jakiej sytuacji"),
        "kwestia": _s("wypowiedź postaci"),
    }), 5, 5),
})


def _field_list(section: str) -> list:
    return FIELDS[section]["fields"]


def _tag(source: str) -> str:
    return "[AUTOR]" if source == "user" else "[LOSOWE]"


def _cell(spec: dict, section: str, key: str) -> dict:
    c = (spec.get(section) or {}).get(key) or {}
    return {"value": c.get("value"), "source": c.get("source", "unset")}


def _level(v) -> int | None:
    if v is None:
        return None
    try:
        v = int(v)
    except (TypeError, ValueError):
        return None
    return v if 0 <= v <= 5 else None


def build_user_message(spec: dict) -> str:
    """Compact, structured character specification for the model."""
    lines = ["# KARTA POSTACI", "", "## Dane podstawowe"]
    for f in _field_list("basic"):
        c = _cell(spec, "basic", f["key"])
        val = (c["value"] or "").strip() if isinstance(c["value"], str) else ""
        if val and c["source"] in ("user", "generated"):
            lines.append(f"- {f['label']}: {val} {_tag(c['source'])}")
        else:
            lines.append(f"- {f['label']}: [DO USTALENIA]")

    def level_section(section: str, words: list, title: str):
        lines.extend(["", f"## {title} (0–5)"])
        for f in _field_list(section):
            c = _cell(spec, section, f["key"])
            v = _level(c["value"])
            if v is None:
                continue
            lines.append(f"- {f['label']}: {v} – {words[v]} {_tag(c['source'])}")

    level_section("life_priorities", PRIORITY_WORDS, "Priorytety życiowe")

    lines.extend(["", "## Osie osobowości (1 = lewy biegun, 5 = prawy biegun)"])
    for f in _field_list("mental_axes"):
        c = _cell(spec, "mental_axes", f["key"])
        v = _level(c["value"])
        if v is None or v < 1:
            continue
        desc = {1: f"zdecydowanie {f['left']}", 2: f"raczej {f['left']}", 3: "pośrodku",
                4: f"raczej {f['right']}", 5: f"zdecydowanie {f['right']}"}[v]
        lines.append(f"- {f['left']} ↔ {f['right']}: {v} ({desc}) {_tag(c['source'])}")

    level_section("character_traits", LEVEL_WORDS, "Cechy charakteru")
    level_section("social_traits", LEVEL_WORDS, "Cechy społeczne")

    tensions = [t for t in (spec.get("tensions") or []) if isinstance(t, str)][:8]
    if tensions:
        lines.extend(["", "## Napięcia do wyjaśnienia (nie spłaszczaj ich)"])
        lines.extend(f"- {t}" for t in tensions)

    prompt = (spec.get("additional_prompt") or "").strip()
    lines.extend(["", "## Opis od autora (świat, pomysł, ograniczenia)"])
    lines.append(prompt[:4000] if prompt else "(brak – wymyśl pasujący, niebanalny kontekst)")

    lines.extend(["", "Stwórz pełny profil postaci zgodnie ze schematem JSON."])
    return "\n".join(lines)


def build_messages(spec: dict) -> list:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_message(spec)},
    ]
