"""Tests for tuning_range: what a receiver says it covers.

Run with:  python3 -m unittest test_tuning_range -v
"""

import unittest

from tuning_range import (
    DEFAULT_MAX_FREQUENCY, DEFAULT_MIN_FREQUENCY, format_range, tuning_range_from,
)

DEFAULTS = (DEFAULT_MIN_FREQUENCY, DEFAULT_MAX_FREQUENCY)


class TestTuningRange(unittest.TestCase):
    def test_receiver_wider_than_the_old_assumption(self):
        """The case this exists for: a 60 MHz receiver, as m9psy publishes.

        The old hardcoded 30 MHz refused 6 m on a receiver that covers it, and
        discarded the receiver's own default frequency when it sat above 30 MHz.
        """
        lo, hi = tuning_range_from(
            {'tuning_range': {'min_frequency': 10000, 'max_frequency': 60000000}})
        self.assertEqual((lo, hi), (10_000, 60_000_000))
        self.assertLessEqual(lo, 50_313_000)
        self.assertGreaterEqual(hi, 50_313_000)   # 6 m is inside it

    def test_each_edge_falls_back_independently(self):
        self.assertEqual(tuning_range_from({'tuning_range': {'min_frequency': 1000}}),
                         (1000, DEFAULT_MAX_FREQUENCY))
        self.assertEqual(tuning_range_from({'tuning_range': {'max_frequency': 54_000_000}}),
                         (DEFAULT_MIN_FREQUENCY, 54_000_000))

    def test_not_said_leaves_the_default(self):
        for body in (
            {'tuning_range': {'min_frequency': 0, 'max_frequency': 0}},
            {'tuning_range': {'min_frequency': -1, 'max_frequency': -2}},
            {'tuning_range': {'min_frequency': None}},
            {'tuning_range': {'min_frequency': 'x', 'max_frequency': []}},
            {'tuning_range': None},
            {'tuning_range': 'not an object'},
            {'receiver': {'callsign': 'M0TST'}},
            {},
            None,
        ):
            self.assertEqual(tuning_range_from(body), DEFAULTS, body)

    def test_inverted_range_is_refused_whole(self):
        """An inverted range would reject every frequency there is, so it is
        treated as a misconfigured receiver rather than adopted."""
        self.assertEqual(
            tuning_range_from({'tuning_range': {'min_frequency': 30_000_000,
                                                'max_frequency': 10_000}}),
            DEFAULTS)
        self.assertEqual(
            tuning_range_from({'tuning_range': {'min_frequency': 1_000_000,
                                                'max_frequency': 1_000_000}}),
            DEFAULTS)

    def test_format_range(self):
        self.assertEqual(format_range(10_000, 60_000_000), '0.010000 - 60.000000 MHz')


if __name__ == '__main__':
    unittest.main()
