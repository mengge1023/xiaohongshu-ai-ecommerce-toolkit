#!/usr/bin/env python3
"""Validate and score one complete product from JSON stdin or a JSON file."""
import sys
from common import load_config, lower_bound_score, read_input, upper_bound_score, write_output
from validate_product import validate


def score(data, config=None):
    cfg = config or load_config()
    checked = validate(data, cfg)
    if checked["hard_fail"]:
        return checked
    if checked["missing_fields"]:
        return {**checked, "score": None, "grade": None, "verdict": None}
    primary = checked["primary_benchmark"]
    profit_margin = checked["profit"]["profit_margin"]
    components = {
        "followers": primary["followers_score"],
        "recency": primary["recency_score"],
        "cart_24h": lower_bound_score(data["cart_24h"], cfg["cart_24h"]["score_bands"]),
        "sales_total": upper_bound_score(data["sales_total"], cfg["sales"]["score_bands"]),
        "profit": lower_bound_score(profit_margin, cfg["profit"]["score_bands"]),
        "material": cfg["material"][str(data["material_level"]).upper()]
    }
    total = sum(components.values())
    grade = next(item for item in cfg["grades"] if total >= item["min"])
    verdict = grade["verdict"]
    if "profit_source_not_ready" in checked["flags"]:
        verdict = "当前货源不行，重新找货源"
    elif "material_source_too_difficult" in checked["flags"]:
        verdict = "换品"
    return {**checked, "score_components": components, "score": total, "grade": grade["grade"], "verdict": verdict}


if __name__ == "__main__":
    if "--help" in sys.argv:
        print(__doc__)
    else:
        try:
            write_output(score(read_input()))
        except (ValueError, KeyError, TypeError) as exc:
            write_output({"error": str(exc)})
            raise SystemExit(2)
