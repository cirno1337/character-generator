"""python3 -m unittest discover -s tests"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import prompts  # noqa: E402
import server  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "sample_character.json"


def spec(**sections):
    base = {"basic": {}, "life_priorities": {}, "mental_axes": {}, "character_traits": {}, "social_traits": {},
            "additional_prompt": ""}
    base.update(sections)
    return base


class PromptTests(unittest.TestCase):
    def test_locked_generated_unset_and_zero(self):
        msg = prompts.build_user_message(spec(
            basic={"name": {"value": "Ala Nowak", "source": "user"}, "race": {"value": "", "source": "unset"}},
            life_priorities={"power": {"value": 0, "source": "user"}, "love": {"value": None, "source": "unset"}},
            mental_axes={"kind_vs_cruel": {"value": 2, "source": "generated"}},
            additional_prompt="Nauczycielka, nie jest wojowniczką.",
        ))
        self.assertIn("Imię/nazwisko: Ala Nowak [AUTOR]", msg)
        self.assertIn("Rasa: [DO USTALENIA]", msg)
        self.assertIn("Władza: 0 – zupełnie nieważne [AUTOR]", msg)   # zero is sent
        self.assertNotIn("Miłość", msg)                                  # unset is omitted
        self.assertIn("Miły ↔ Wredny: 2 (raczej Miły) [LOSOWE]", msg)
        self.assertIn("nie jest wojowniczką", msg)

    def test_system_prompt_not_in_user_message_and_messages_shape(self):
        m = prompts.build_messages(spec())
        self.assertEqual([x["role"] for x in m], ["system", "user"])
        self.assertIn("PRIORITY OF CONSTRAINTS", m[0]["content"])
        self.assertIn("brak – wymyśl", m[1]["content"])

    def test_garbage_values_are_ignored(self):
        msg = prompts.build_user_message(spec(character_traits={"empathy": {"value": 9, "source": "user"},
                                                                "ambition": {"value": "x", "source": "user"}}))
        self.assertNotIn("Empatia", msg)
        self.assertNotIn("Ambicja", msg)


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.good = FIXTURE.read_text(encoding="utf-8")

    def test_valid(self):
        obj, trunc = server.parse_character(self.good)
        self.assertFalse(trunc)
        self.assertIn("koncepcja", obj)

    def test_fenced_and_prefixed(self):
        obj, _ = server.parse_character("Oto postać:\n```json\n" + self.good + "\n```")
        self.assertIn("koncepcja", obj)

    def test_truncated_is_repaired(self):
        cut = self.good[: len(self.good) // 2]
        obj, trunc = server.parse_character(cut)
        self.assertTrue(trunc)
        self.assertIsNotNone(obj)
        norm = server.normalize_character(obj)
        self.assertEqual(set(norm), set(prompts.OUTPUT_SCHEMA["properties"]))
        self.assertIsInstance(norm["wypowiedzi"], list)

    def test_not_json(self):
        obj, _ = server.parse_character("## Postać\nTo nie jest JSON.")
        self.assertIsNone(obj)

    def test_normalize_fills_missing(self):
        norm = server.normalize_character({"koncepcja": "x", "detale": ["a", 3]})
        self.assertEqual(norm["koncepcja"], "x")
        self.assertEqual(norm["detale"], ["a", "3"])
        self.assertEqual(norm["motywacja"]["czego_chce"], "")


class UnreachableTests(unittest.TestCase):
    def setUp(self):
        self.orig = server.LLAMA_URL
        server.LLAMA_URL = "http://127.0.0.1:9"   # nothing listens there

    def tearDown(self):
        server.LLAMA_URL = self.orig

    def test_status(self):
        s = server.llama_status()
        self.assertFalse(s["ok"])
        self.assertIn("llama-start.sh", s["error"])

    def test_generate_raises_friendly_error(self):
        with self.assertRaises(server.LlamaError) as ctx:
            server.generate(spec(), lambda e: None)
        self.assertIn("Nie udało się połączyć z lokalnym Gemma 4", str(ctx.exception))


class SchemaTests(unittest.TestCase):
    def test_fixture_matches_schema_keys(self):
        obj = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(list(obj), list(prompts.OUTPUT_SCHEMA["properties"]))


if __name__ == "__main__":
    unittest.main()
