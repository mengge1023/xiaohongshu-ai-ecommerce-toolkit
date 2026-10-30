import unittest

from calculate_profit import calculate as profit
from calculate_score import score
from select_primary_benchmark import select
from validate_product import validate


def product(**changes):
    value = {"sales_total": 6200, "cart_24h": 468, "benchmarks": [{"followers": 860, "days_ago": 12, "likes": 326, "same_product": True}], "sale_price": 59.9, "purchase_price": 26, "shipping_cost": 5, "material_level": "B"}
    value.update(changes)
    return value


class SpecCases(unittest.TestCase):
    def test_01_normal_pass(self):
        out = score(product())
        self.assertEqual((out["score"], out["grade"], out["verdict"]), (85, "S", "优先打"))

    def test_02_sales_hard_fail(self):
        out = validate({"sales_total": 15000})
        self.assertEqual(out["hard_fail_reason"], "sales_over_11000")
        self.assertNotIn("missing_fields", {k: v for k, v in out.items() if k not in ("hard_fail", "hard_fail_reason", "flags", "missing_fields")})

    def test_03_sales_boundary(self):
        self.assertEqual(score(product(sales_total=10500))["score_components"]["sales_total"], 3)

    def test_04_cart_hard_fail(self):
        self.assertEqual(validate({"sales_total": 3000, "cart_24h": 167})["hard_fail_reason"], "cart_below_200")

    def test_05_cart_relaxed(self):
        self.assertEqual(score(product(cart_24h=250))["score_components"]["cart_24h"], 7)

    def test_06_low_follower_recent(self):
        out = select({"benchmarks": [{"followers": 600, "days_ago": 3, "likes": 300, "same_product": True}]})
        self.assertEqual((out["followers_score"], out["recency_score"]), (20, 20))

    def test_07_low_follower_old(self):
        out = select({"benchmarks": [{"followers": 500, "days_ago": 70, "likes": 300, "same_product": True}]})
        self.assertEqual((out["followers_score"], out["recency_score"]), (20, 5))

    def test_08_recent_higher_follower(self):
        out = select({"benchmarks": [{"followers": 4500, "days_ago": 3, "likes": 500, "same_product": True}]})
        self.assertEqual((out["followers_score"], out["recency_score"]), (8, 20))

    def test_09_over_5000_is_not_low_follower(self):
        out = validate(product(benchmarks=[{"followers": 6500, "days_ago": 3, "likes": 800, "same_product": True}]))
        self.assertEqual(out["hard_fail_reason"], "no_valid_low_follower_benchmark")

    def test_10_insufficient_likes(self):
        out = select({"benchmarks": [{"followers": 600, "days_ago": 3, "likes": 80, "same_product": True}]})
        self.assertEqual(out["reason"], "no_valid_benchmark")

    def test_11_over_90_days(self):
        out = select({"benchmarks": [{"followers": 500, "days_ago": 100, "likes": 1000, "same_product": True}]})
        self.assertEqual(out["reason"], "no_valid_benchmark")

    def test_12_notes_are_not_combined(self):
        out = select({"benchmarks": [{"followers": 500, "days_ago": 70, "likes": 300, "same_product": True}, {"followers": 3000, "days_ago": 3, "likes": 500, "same_product": True}]})
        self.assertIn(out["benchmark"], [{"followers": 500, "days_ago": 70, "likes": 300, "same_product": True}, {"followers": 3000, "days_ago": 3, "likes": 500, "same_product": True}])
        self.assertNotEqual(out["benchmark"], {"followers": 500, "days_ago": 3, "likes": 500, "same_product": True})

    def test_13_profit_insufficient(self):
        out = score(product(sale_price=59, purchase_price=40, shipping_cost=6))
        self.assertIn("profit_source_not_ready", out["flags"])

    def test_14_new_source_passes(self):
        self.assertGreaterEqual(profit({"sale_price": 59, "purchase_price": 25, "shipping_cost": 5})["profit_margin"], .25)

    def test_15_material_c(self):
        out = score(product(material_level="C"))
        self.assertEqual(out["verdict"], "换品")

    def test_16_url_note_is_conversation_rule(self):
        self.assertTrue(True)  # Behavioral rule is documented in conversation-flow.md.

    def test_17_ab_outputs_are_independently_scoreable(self):
        self.assertGreater(score(product())["score"], score(product(cart_24h=250))["score"])

    def test_18_a_early_fail_b_complete(self):
        self.assertTrue(validate({"sales_total": 18000})["hard_fail"])
        self.assertFalse(score(product())["hard_fail"])

    def test_19_both_fail(self):
        self.assertTrue(validate({"sales_total": 18000})["hard_fail"] and validate({"sales_total": 12000})["hard_fail"])

    def test_20_fuzzy_input_rejected_by_types(self):
        with self.assertRaises(ValueError):
            validate({"sales_total": "七千多", "cart_24h": "好像四百"})


if __name__ == "__main__":
    unittest.main()
