#!/usr/bin/env python3
"""
Tests for target selection.

The failure this guards against is camping: a loud frequency with a DX spot and
a previous success scores highly enough to beat unvisited targets even with its
idle bonus at zero, so a pure priority sort will keep picking it and the rest of
the band never gets scanned.
"""

import time
import unittest

from activity import ActivityTracker, Target


def tracker_with(*targets) -> ActivityTracker:
    tracker = ActivityTracker(base_url="http://localhost")
    for target in targets:
        tracker._targets[target.key] = target
    return tracker


def make(freq, snr=10.0, conf=0.8, band="20m", **kw) -> Target:
    return Target(
        band=band, dial_freq=freq, mode="usb", snr=snr, confidence=conf, **kw
    )


class TestRotation(unittest.TestCase):
    def test_does_not_repeat_last_frequency(self):
        # A is overwhelmingly attractive and was just visited.
        a = make(14200000, snr=40.0, conf=0.95, dx_callsign="MM3NDH")
        a.last_visited = time.time()
        a.callsigns_found = 3
        b = make(14250000, snr=8.0, conf=0.7)

        tracker = tracker_with(a, b)
        chosen = tracker.next_target(exclude=a.key, cooldown=120.0)
        self.assertEqual(chosen.key, b.key, "camped on the just-visited target")

    def test_priority_alone_would_have_camped(self):
        """Documents why the exclusion tier is needed at all."""
        a = make(14200000, snr=40.0, conf=0.95, dx_callsign="MM3NDH")
        a.last_visited = time.time()
        a.callsigns_found = 3
        b = make(14250000, snr=8.0, conf=0.7)
        self.assertGreater(a.priority(), b.priority())

    def test_cooldown_blocks_recent_visit(self):
        a = make(14200000, snr=30.0)
        a.last_visited = time.time() - 10
        b = make(14250000, snr=5.0)

        tracker = tracker_with(a, b)
        self.assertEqual(
            tracker.next_target(cooldown=120.0).key, b.key
        )

    def test_cooldown_expires(self):
        # Both visited, so neither gets the unvisited bonus: the only thing
        # separating them is whether their cooldown has elapsed.
        now = time.time()
        a = make(14200000, snr=30.0)
        a.last_visited = now - 300          # cooldown long expired
        b = make(14250000, snr=5.0)
        b.last_visited = now - 10           # still in cooldown

        tracker = tracker_with(a, b)
        self.assertEqual(tracker.next_target(cooldown=120.0).key, a.key)

    def test_unvisited_beats_a_stronger_stale_target(self):
        # Deliberate: coverage is worth more than signal strength. A target
        # visited five minutes ago loses to one never heard, even at 6x the SNR.
        a = make(14200000, snr=30.0)
        a.last_visited = time.time() - 300
        b = make(14250000, snr=5.0)

        tracker = tracker_with(a, b)
        self.assertEqual(tracker.next_target(cooldown=120.0).key, b.key)

    def test_single_target_still_returned(self):
        # With nothing else on the air, revisiting is correct.
        a = make(14200000)
        a.last_visited = time.time()
        tracker = tracker_with(a)
        self.assertEqual(tracker.next_target(exclude=a.key, cooldown=120.0).key, a.key)

    def test_all_in_cooldown_falls_through(self):
        now = time.time()
        a = make(14200000, snr=30.0)
        b = make(14250000, snr=5.0)
        a.last_visited = now - 5
        b.last_visited = now - 5

        tracker = tracker_with(a, b)
        chosen = tracker.next_target(exclude=a.key, cooldown=120.0)
        self.assertEqual(chosen.key, b.key, "should still rotate, not stall")

    def test_unvisited_preferred_over_visited(self):
        a = make(14200000, snr=25.0)
        a.last_visited = time.time() - 200
        b = make(14250000, snr=10.0)  # never visited

        tracker = tracker_with(a, b)
        self.assertEqual(tracker.next_target(cooldown=120.0).key, b.key)

    def test_full_sweep_covers_every_target(self):
        """Ten dwells across four targets must touch all four."""
        targets = [make(14200000 + i * 5000, snr=30.0 - i) for i in range(4)]
        tracker = tracker_with(*targets)

        seen = set()
        last = None
        for _ in range(10):
            chosen = tracker.next_target(exclude=last, cooldown=120.0)
            seen.add(chosen.key)
            tracker.mark_visited(chosen)
            last = chosen.key

        self.assertEqual(len(seen), 4, f"only reached {len(seen)} of 4 targets")

    def test_no_targets(self):
        self.assertIsNone(tracker_with().next_target())

    def test_long_run_never_starves_a_target(self):
        """
        Over a realistic run the strong target should be favoured but must not
        starve the weak ones, and must never be picked twice in a row.
        """
        import activity as activity_module

        clock = [1_000_000.0]
        real_time = activity_module.time.time
        activity_module.time.time = lambda: clock[0]
        try:
            targets = []
            for i in range(6):
                t = make(14200000 + i * 5000, snr=30.0 - i * 4, conf=0.9 - i * 0.03)
                t.first_seen = t.last_seen = clock[0]
                if i == 0:
                    t.dx_callsign = "MM3NDH"
                targets.append(t)
            tracker = tracker_with(*targets)

            order = []
            last = None
            for _ in range(24):
                for t in tracker._targets.values():
                    t.last_seen = clock[0]      # keep them from expiring
                chosen = tracker.next_target(exclude=last, cooldown=120.0)
                order.append(chosen.dial_freq)
                tracker.mark_visited(chosen)
                if chosen.dial_freq == 14200000:
                    tracker.record_success(chosen, 1)
                last = chosen.key
                clock[0] += 45.0
        finally:
            activity_module.time.time = real_time

        repeats = sum(1 for i in range(1, len(order)) if order[i] == order[i - 1])
        self.assertEqual(repeats, 0, "picked the same frequency twice in a row")
        self.assertEqual(len(set(order)), 6, "starved at least one target")

        # The best target should be favoured, but not to the point of dominance.
        share = order.count(14200000) / len(order)
        self.assertGreater(share, 1 / 6, "strong target not favoured at all")
        self.assertLess(share, 0.5, "strong target monopolised the scan")


class TestVisitAccounting(unittest.TestCase):
    def test_success_does_not_count_as_a_visit(self):
        # Successes arrive asynchronously, after the dwell has ended.
        a = make(14200000)
        tracker = tracker_with(a)

        tracker.mark_visited(a)
        tracker.record_success(a, 2)
        tracker.record_success(a, 1)

        live = tracker._targets[a.key]
        self.assertEqual(live.visits, 1)
        self.assertEqual(live.callsigns_found, 3)

    def test_zero_successes_ignored(self):
        a = make(14200000)
        tracker = tracker_with(a)
        tracker.record_success(a, 0)
        self.assertEqual(tracker._targets[a.key].callsigns_found, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
