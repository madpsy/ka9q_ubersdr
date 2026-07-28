"""
Callsign extraction from speech-to-text output.

The hard problem this file solves: Whisper returns ordinary English prose, and a
spoken callsign arrives as words — "mike mike three november delta hotel" — or
occasionally already spelled out ("MM3NDH"), or as some mixture of the two.

Two things make naive matching useless:

  1. Amateur operators routinely ignore the NATO alphabet. "Germany Four Radio
     Sugar" is a perfectly ordinary way to send G4RS on the air.
  2. Many phonetic words are also ordinary English. "for" is 4, "to" is 2, "one"
     is 1, "oh" is 0, "king" is K. A transcript of someone saying "for you to
     read" trivially yields the token run 4-U-2-R.

So mappings are split into two tiers. STRICT words are unambiguous on-air
phonetics that essentially never appear in conversational English ("foxtrot",
"niner", "zulu"). LOOSE words are the ambiguous ones. A run of tokens is only
promoted to a candidate if it carries enough strict evidence, or if it directly
follows a cue phrase like "this is" / "cq" / "de", which is where callsigns
actually live.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

# ---------------------------------------------------------------------------
# Phonetic vocabulary
# ---------------------------------------------------------------------------

# Unambiguous on-air phonetics — these words are vanishingly rare in ordinary
# speech, so a match is strong evidence we are inside a callsign.
STRICT_LETTERS: Dict[str, str] = {
    "alpha": "A", "alfa": "A",
    "bravo": "B",
    "charlie": "C", "charley": "C",
    "delta": "D",
    "foxtrot": "F",
    "golf": "G",
    "hotel": "H",
    "india": "I",
    "juliet": "J", "juliett": "J", "juliette": "J",
    "kilo": "K",
    "lima": "L",
    "november": "N",
    "oscar": "O",
    "papa": "P",
    "quebec": "Q",
    "romeo": "R",
    "sierra": "S",
    "tango": "T",
    "uniform": "U",
    "victor": "V",
    "whiskey": "W", "whisky": "W",
    "xray": "X", "x-ray": "X",
    "yankee": "Y",
    "zulu": "Z",
}

# Ambiguous phonetics: real English words, common ASR mishearings, and the
# non-standard "geographic" phonetics hams use constantly.
LOOSE_LETTERS: Dict[str, str] = {
    "america": "A", "amsterdam": "A", "able": "A",
    "boston": "B", "baker": "B", "bravo!": "B",
    "canada": "C", "california": "C",
    "denmark": "D", "david": "D", "dog": "D",
    "echo": "E", "england": "E", "easy": "E", "edward": "E",
    "florida": "F", "fox": "F", "france": "F",
    "germany": "G", "george": "G", "guatemala": "G",
    "henry": "H", "honolulu": "H", "havana": "H",
    "italy": "I", "india!": "I", "item": "I",
    "japan": "J", "john": "J", "jupiter": "J",
    "king": "K", "kilowatt": "K", "kentucky": "K",
    "london": "L", "lincoln": "L", "love": "L",
    "mike": "M", "mic": "M", "michael": "M", "mexico": "M", "mary": "M",
    "norway": "N", "nancy": "N", "nov": "N",
    "ontario": "O", "ocean": "O", "oboe": "O",
    "portugal": "P", "peter": "P", "pacific": "P",
    "queen": "Q", "quebec!": "Q",
    "radio": "R", "roger": "R",
    "sugar": "S", "santiago": "S", "spain": "S", "sweden": "S",
    "texas": "T", "tokyo": "T", "toronto": "T",
    "union": "U", "united": "U", "uncle": "U",
    "venezuela": "V", "victoria": "V",
    "washington": "W", "william": "W",
    "xylophone": "X",
    "yokohama": "Y", "yellow": "Y", "young": "Y",
    "zanzibar": "Z", "zed": "Z", "zebra": "Z",
}

# Digit words. Aviation/on-air forms ("niner", "fife", "fower", "tree") are
# strict; the plain English numbers are ambiguous.
STRICT_DIGITS: Dict[str, str] = {
    "niner": "9",
    "fife": "5",
    "fower": "4",
    "tree": "3",
    "zeero": "0",
}

LOOSE_DIGITS: Dict[str, str] = {
    "zero": "0", "oh": "0", "o": "0", "nought": "0", "naught": "0",
    "one": "1", "won": "1", "wun": "1",
    "two": "2", "too": "2", "to": "2",
    "three": "3", "free": "3", "thee": "3",
    "four": "4", "for": "4", "fore": "4",
    "five": "5",
    "six": "6", "sicks": "6",
    "seven": "7",
    "eight": "8", "ate": "8", "ait": "8",
    "nine": "9", "nina": "9",
}

# Phrases that immediately precede a callsign on the air. A run following one of
# these within a couple of tokens gets a large confidence boost, which is what
# lets us accept otherwise-ambiguous runs like "for radio sugar".
CUE_PHRASES: List[List[str]] = [
    ["this", "is"],
    ["cq"],
    ["de"],
    ["from"],
    ["callsign"],
    ["call", "sign"],
    ["my", "call"],
    ["station"],
    ["calling"],
    ["qrz"],
    ["back", "to"],
    ["over", "to"],
    ["handle", "is"],
    ["name", "here", "is"],
]

# Words that terminate a callsign run — spoken suffixes and sign-off words that
# would otherwise be swallowed into the candidate.
SUFFIX_WORDS: Dict[str, str] = {
    "portable": "/P",
    "mobile": "/M",
    "maritime": "/MM",
    "stroke": "/",
    "slash": "/",
}

STRICT_MAP = {**STRICT_LETTERS, **STRICT_DIGITS}
LOOSE_MAP = {**LOOSE_LETTERS, **LOOSE_DIGITS}
FULL_MAP = {**LOOSE_MAP, **STRICT_MAP}  # strict wins on collision

# ---------------------------------------------------------------------------
# Callsign structure
# ---------------------------------------------------------------------------

# ITU-shaped callsign: prefix (1-2 letters, or letter+digit, or digit+letter),
# a separating digit or two, then a 1-4 letter suffix.
# Matches M0ABC, MM3NDH, G4RS, W1AW, 2E0ABC, 9A1A, 4X4ABC, VK2XYZ.
CALLSIGN_RE = re.compile(r"^(?:[A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])[0-9]{1,2}[A-Z]{1,4}$")

# Callsigns Whisper wrote out literally, e.g. "MM3NDH" or "M0ABC" mid-sentence.
LITERAL_RE = re.compile(
    r"\b(?:[A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])[0-9]{1,2}[A-Z]{1,4}\b"
)

# Word-ish tokens; keeps hyphens so "x-ray" survives tokenisation.
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9'-]*")


# What the server itself will accept, post-normalisation (reValidCallsign in
# lookup_api.go). Anything failing this is a guaranteed 400, so there is no
# point spending a request on it.
SERVER_CALLSIGN_RE = re.compile(r"^[A-Z0-9]{3,10}$")


def is_callsign_shaped(text: str) -> bool:
    """True if `text` has the structure of an amateur callsign."""
    return bool(CALLSIGN_RE.match(text))


def is_lookupable(call: str) -> bool:
    """
    Final gate before spending a lookup.

    Re-checks structure *after* normalisation, which the extraction-time check
    cannot do: stripping a prefix overlay can leave something that is no longer
    a callsign at all ("G/M" normalises to "M"). Also enforces the server's own
    3-10 alphanumeric rule so we never send a request that is certain to 400.
    """
    call = call.upper().strip()
    if not SERVER_CALLSIGN_RE.match(call):
        return False
    return is_callsign_shaped(call)


@dataclass
class Candidate:
    """A possible callsign recovered from a transcript."""

    callsign: str
    source: str                  # "phonetic" | "literal"
    confidence: float            # 0.0-1.0, heuristic prior before validation
    strict_tokens: int = 0
    loose_tokens: int = 0
    cued: bool = False
    context: str = ""            # surrounding transcript text, for the log
    suffix: str = ""             # spoken "/P", "/M" etc. if heard

    def __hash__(self) -> int:
        return hash((self.callsign, self.source))


def normalise_text(text: str) -> str:
    """Lowercase and strip punctuation that would break tokenisation."""
    text = text.lower()
    text = text.replace("_", " ")
    # Keep intra-word hyphens/apostrophes; drop everything else.
    text = re.sub(r"[^a-z0-9'\- ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokenise(text: str) -> List[str]:
    return TOKEN_RE.findall(normalise_text(text))


def _cue_positions(tokens: List[str]) -> Set[int]:
    """Token indices at which a callsign could plausibly start."""
    positions: Set[int] = set()
    for cue in CUE_PHRASES:
        n = len(cue)
        for i in range(len(tokens) - n + 1):
            if tokens[i:i + n] == cue:
                # Allow a token or two of slack ("this is, uh, mike mike three").
                positions.update({i + n, i + n + 1, i + n + 2})
    return positions


def extract_phonetic(tokens: List[str], cues: Set[int]) -> List[Candidate]:
    """Find runs of phonetic tokens and promote the plausible ones."""
    candidates: List[Candidate] = []
    i = 0
    while i < len(tokens):
        if tokens[i] not in FULL_MAP:
            i += 1
            continue

        # Consume the maximal run of mappable tokens.
        start = i
        chars: List[str] = []
        strict = 0
        loose = 0
        while i < len(tokens) and tokens[i] in FULL_MAP:
            token = tokens[i]
            chars.append(FULL_MAP[token])
            if token in STRICT_MAP:
                strict += 1
            else:
                loose += 1
            i += 1

        # A spoken suffix directly after the run ("...delta hotel portable").
        suffix = ""
        if i < len(tokens) and tokens[i] in SUFFIX_WORDS:
            suffix = SUFFIX_WORDS[tokens[i]]

        cued = any(pos in cues for pos in range(start, start + 2))

        # Try the whole run first, then progressively trim from the left. A run
        # often has a leading stray ("...and four radio sugar" → AND4RS), and the
        # callsign is the right-hand part.
        for offset in range(0, min(3, max(0, len(chars) - 3)) + 1):
            text = "".join(chars[offset:])
            if len(text) < 3 or len(text) > 10:
                continue
            if not is_callsign_shaped(text):
                continue

            run_strict = sum(
                1 for t in tokens[start + offset:i] if t in STRICT_MAP
            )
            run_loose = len(text) - run_strict

            # Evidence gate. Without a cue we demand real strict content,
            # otherwise ordinary speech ("for you to read") becomes a callsign.
            if not cued and run_strict < 2:
                continue
            if cued and run_strict < 1 and run_loose < 3:
                continue

            confidence = 0.25
            confidence += 0.10 * min(run_strict, 4)
            if cued:
                confidence += 0.25
            if offset == 0:
                confidence += 0.05
            confidence = min(confidence, 0.95)

            candidates.append(
                Candidate(
                    callsign=text,
                    source="phonetic",
                    confidence=confidence,
                    strict_tokens=run_strict,
                    loose_tokens=run_loose,
                    cued=cued,
                    context=" ".join(tokens[max(0, start - 4):i + 2]),
                    suffix=suffix,
                )
            )
            break  # first (longest) shape-valid trim wins

    return candidates


def extract_literal(text: str, tokens: List[str], cues: Set[int]) -> List[Candidate]:
    """Find callsigns Whisper already spelled out."""
    candidates: List[Candidate] = []
    for match in LITERAL_RE.finditer(text.upper()):
        call = match.group(0)
        if not is_callsign_shaped(call):
            continue
        # A literal hit is strong on its own — Whisper does not usually emit
        # callsign-shaped alphanumeric strings by accident.
        confidence = 0.7
        if cues:
            confidence += 0.1
        candidates.append(
            Candidate(
                callsign=call,
                source="literal",
                confidence=min(confidence, 0.95),
                strict_tokens=0,
                loose_tokens=0,
                cued=bool(cues),
                context=text[max(0, match.start() - 40):match.end() + 20].strip(),
            )
        )
    return candidates


def extract_callsigns(text: str) -> List[Candidate]:
    """
    Extract candidate callsigns from one transcript segment.

    Returns candidates ordered by descending heuristic confidence. Confidence
    here is only a prior — it says how callsign-like the utterance was, not
    whether the callsign exists. Validation against CTY/QRZ happens downstream.
    """
    if not text or not text.strip():
        return []

    tokens = tokenise(text)
    if not tokens:
        return []

    cues = _cue_positions(tokens)

    candidates = extract_literal(text, tokens, cues)
    candidates.extend(extract_phonetic(tokens, cues))

    # Deduplicate, keeping the highest-confidence instance of each callsign.
    best: Dict[str, Candidate] = {}
    for cand in candidates:
        existing = best.get(cand.callsign)
        if existing is None or cand.confidence > existing.confidence:
            best[cand.callsign] = cand

    return sorted(best.values(), key=lambda c: c.confidence, reverse=True)


# ---------------------------------------------------------------------------
# Normalisation — mirrors NormaliseCallsign in qrz_lookup.go so that what we
# send to /api/lookup matches what the server will key its cache on.
# ---------------------------------------------------------------------------

KNOWN_SUFFIXES = {
    "P", "M", "MM", "AM", "QRP", "A", "B", "R", "LH", "BCN", "AG", "AE", "KT",
}


def normalise_callsign(call: str) -> str:
    """Strip portable suffixes and country-prefix overlays."""
    call = call.upper().strip()
    if not call:
        return call

    parts = call.split("/", 1)
    if len(parts) == 1:
        return call

    left, right = parts[0], parts[1]

    if right in KNOWN_SUFFIXES:
        return left
    if left.isalpha() and len(left) <= 3:
        return right
    if len(right) > len(left):
        return right
    return left
