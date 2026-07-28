#!/usr/bin/env python3
"""
Tests for callsign extraction.

The negative cases matter more than the positive ones. The extractor's whole
risk is false positives: many phonetic words are ordinary English, so plain
conversation trivially yields callsign-shaped token runs. Any change that makes
recall better while letting these through is a bad trade — QRZ will reject the
junk, but every rejection is a wasted lookup and a polluted log.
"""

import unittest

from phonetics import (
    extract_callsigns,
    is_callsign_shaped,
    is_lookupable,
    normalise_callsign,
    tokenise,
)


def calls(text):
    return [c.callsign for c in extract_callsigns(text)]


class TestCallsignShape(unittest.TestCase):
    def test_accepts_real_formats(self):
        for call in [
            "M0ABC", "MM3NDH", "G4RS", "W1AW", "2E0ABC",
            "9A1A", "4X4ABC", "VK2XYZ", "OH2BH", "JA1ABC",
        ]:
            self.assertTrue(is_callsign_shaped(call), call)

    def test_rejects_non_callsigns(self):
        for text in ["ABC", "HELLO", "12345", "A", "TOOLONGCALLSIGN", "M"]:
            self.assertFalse(is_callsign_shaped(text), text)


class TestPhoneticExtraction(unittest.TestCase):
    def test_standard_nato_with_cue(self):
        text = "CQ CQ this is mike mike three november delta hotel calling CQ"
        self.assertIn("MM3NDH", calls(text))

    def test_without_cue_still_found_when_strict(self):
        text = "golf four alpha bravo charlie standing by"
        self.assertIn("G4ABC", calls(text))

    def test_ham_geographic_phonetics_with_cue(self):
        # Non-standard phonetics are extremely common on the air.
        text = "this is germany four radio sugar portable"
        self.assertIn("G4RS", calls(text))

    def test_aviation_digit_forms(self):
        text = "this is whiskey one alpha whiskey"
        self.assertIn("W1AW", calls(text))
        text = "kilo niner foxtrot oscar xray"
        self.assertIn("K9FOX", calls(text))

    def test_literal_callsign_in_text(self):
        text = "Thanks for the call MM3NDH, you are five nine here"
        self.assertIn("MM3NDH", calls(text))

    def test_literal_scores_high(self):
        best = extract_callsigns("Thanks MM3NDH for the contact")[0]
        self.assertEqual(best.source, "literal")
        self.assertGreater(best.confidence, 0.6)

    def test_cue_raises_confidence(self):
        cued = extract_callsigns(
            "this is mike mike three november delta hotel"
        )
        plain = extract_callsigns("mike mike three november delta hotel")
        self.assertTrue(cued and plain)
        self.assertGreater(cued[0].confidence, plain[0].confidence)

    def test_spoken_suffix_captured(self):
        found = [
            c for c in extract_callsigns("this is germany four radio sugar portable")
            if c.callsign == "G4RS"
        ]
        self.assertTrue(found)
        self.assertEqual(found[0].suffix, "/P")


class TestFalsePositives(unittest.TestCase):
    """Ordinary speech must not produce callsigns."""

    def test_plain_conversation(self):
        for text in [
            "I would like for you to read that back to me",
            "we have one or two things to do",
            "it was for the best and the weather is fine",
            "thanks for watching and don't forget to subscribe",
            "the king and queen were easy to see",
            "hello there how are you doing today",
            "that is one to four and back again",
        ]:
            self.assertEqual(calls(text), [], f"false positive on: {text}")

    def test_loose_only_run_without_cue_rejected(self):
        # "for radio sugar" is 4RS — all loose, no cue. Must not fire.
        self.assertEqual(calls("waiting for radio sugar to arrive"), [])

    def test_empty_and_noise(self):
        for text in ["", "   ", "...", "uh um er"]:
            self.assertEqual(calls(text), [])


class TestNormalisation(unittest.TestCase):
    def test_strips_known_suffixes(self):
        self.assertEqual(normalise_callsign("MM3NDH/P"), "MM3NDH")
        self.assertEqual(normalise_callsign("W1AW/QRP"), "W1AW")
        self.assertEqual(normalise_callsign("G4ABC/M"), "G4ABC")

    def test_strips_country_prefix(self):
        self.assertEqual(normalise_callsign("G/MM3NDH"), "MM3NDH")
        self.assertEqual(normalise_callsign("VK/W1AW"), "W1AW")

    def test_keeps_longer_part(self):
        self.assertEqual(normalise_callsign("W1AW/KH6ABC"), "KH6ABC")

    def test_plain_callsign_unchanged(self):
        self.assertEqual(normalise_callsign("mm3ndh"), "MM3NDH")


class TestTokenise(unittest.TestCase):
    def test_hyphen_preserved(self):
        self.assertIn("x-ray", tokenise("x-ray"))

    def test_punctuation_stripped(self):
        self.assertEqual(tokenise("Hello, world!"), ["hello", "world"])



class TestLookupGate(unittest.TestCase):
    """The final gate before a QRZ request is spent."""

    def test_accepts_normal_callsigns(self):
        for call in ["M0ABC", "MM3NDH", "W1AW", "2E0ABC", "9A1A"]:
            self.assertTrue(is_lookupable(call), call)

    def test_rejects_post_normalisation_junk(self):
        # "G/M" normalises to "M" — shaped like nothing, and the server would
        # 400 it for being under 3 characters.
        self.assertFalse(is_lookupable(normalise_callsign("G/M")))

    def test_rejects_wrong_shape(self):
        for call in ["ABC", "HELLO", "12345", "TOOLONGCALL"]:
            self.assertFalse(is_lookupable(call), call)

    def test_rejects_non_alphanumeric(self):
        self.assertFalse(is_lookupable("M0-ABC"))
        self.assertFalse(is_lookupable("MM3NDH/P"))

if __name__ == "__main__":
    unittest.main(verbosity=2)
