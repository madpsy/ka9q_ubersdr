#!/usr/bin/env python3
"""
Summarise a detections.jsonl run.

The PoC's real question is not "did it find callsigns" but "what fraction of
what it found was real". This prints the precision of each extraction path so
you can see where the errors concentrate.

    python3 analyse.py detections.jsonl
"""

import json
import sys
from collections import Counter, defaultdict


def load(path):
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except ValueError:
                    pass
    return records


def pct(n, d):
    return f"{100.0 * n / d:5.1f}%" if d else "    —"


def main(path="detections.jsonl"):
    records = load(path)
    if not records:
        print(f"No records in {path}")
        return 1

    total = len(records)
    valid = [r for r in records if r.get("validated")]
    checked = [r for r in records if r.get("lookup_checked")]

    print(f"\n{path}: {total} candidates\n")
    print(f"  Confirmed by QRZ      {len(valid):4d}  {pct(len(valid), total)}")
    print(f"  Definitively checked  {len(checked):4d}  {pct(len(checked), total)}")
    print(f"  Precision (of checked)      {pct(len(valid), len(checked))}")

    # Precision by extraction path — phonetic runs are where the risk is.
    print("\nBy source:")
    by_source = defaultdict(lambda: [0, 0])
    for r in records:
        entry = by_source[r.get("source", "?")]
        entry[0] += 1
        if r.get("validated"):
            entry[1] += 1
    for source, (n, ok) in sorted(by_source.items()):
        print(f"  {source:10} {n:4d} candidates, {ok:3d} confirmed  {pct(ok, n)}")

    # Does the cue phrase actually earn its confidence bonus?
    print("\nBy cue:")
    for cued in (True, False):
        subset = [r for r in records if bool(r.get("cued")) is cued]
        ok = sum(1 for r in subset if r.get("validated"))
        label = "cued" if cued else "uncued"
        print(f"  {label:10} {len(subset):4d} candidates, {ok:3d} confirmed  "
              f"{pct(ok, len(subset))}")

    # Strict-token count is the main gate; check it discriminates.
    print("\nBy strict token count:")
    by_strict = defaultdict(lambda: [0, 0])
    for r in records:
        if r.get("source") != "phonetic":
            continue
        entry = by_strict[r.get("strict_tokens", 0)]
        entry[0] += 1
        if r.get("validated"):
            entry[1] += 1
    for strict, (n, ok) in sorted(by_strict.items()):
        print(f"  {strict:<3} strict  {n:4d} candidates, {ok:3d} confirmed  {pct(ok, n)}")

    straddled = sum(1 for r in records if r.get("straddled_hop"))
    if straddled:
        print(f"\nSpanned a frequency hop: {straddled}  {pct(straddled, total)}")

    agreed = [r for r in records if r.get("agrees_with_dx_spot")]
    if agreed:
        print(f"Matched a DX cluster spot: {len(agreed)}")
        for r in agreed:
            print(f"  {r['normalised']} on {r['frequency']/1e6:.3f} MHz")

    if valid:
        print("\nConfirmed callsigns:")
        seen = {}
        for r in valid:
            seen.setdefault(r["normalised"], r)
        for call, r in sorted(seen.items()):
            who = r.get("name") or r.get("country") or ""
            print(f"  {call:<10} {r['frequency']/1e6:9.3f} MHz  {who}")
            print(f"             \"{r['raw_text'][:100]}\"")

    rejected = [r for r in records if r.get("lookup_checked") and not r.get("validated")]
    if rejected:
        print(f"\nRejected ({len(rejected)}) — what the extractor invented:")
        for call, n in Counter(r["normalised"] for r in rejected).most_common(15):
            example = next(r for r in rejected if r["normalised"] == call)
            print(f"  {call:<10} x{n:<3} from \"{example['raw_text'][:70]}\"")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "detections.jsonl"))
