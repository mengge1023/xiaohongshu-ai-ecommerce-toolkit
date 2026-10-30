#!/usr/bin/env python3
"""Select one primary benchmark without combining fields across notes."""
import sys
from common import load_config, nonnegative_number, read_input, upper_bound_score, write_output


def select(data, config=None):
    cfg = config or load_config()
    rules = cfg["benchmark"]
    valid = []
    for index, raw in enumerate(data.get("benchmarks", [])):
        followers = nonnegative_number(raw.get("followers"), f"benchmarks[{index}].followers")
        days = nonnegative_number(raw.get("days_ago"), f"benchmarks[{index}].days_ago")
        likes = nonnegative_number(raw.get("likes"), f"benchmarks[{index}].likes")
        if raw.get("same_product") is not True or likes < rules["min_likes"] or days > rules["absolute_days"]:
            continue
        fs = upper_bound_score(followers, rules["follower_score_bands"])
        rs = upper_bound_score(days, rules["recency_score_bands"])
        item = {"primary_benchmark_index": index, "benchmark": raw, "followers_score": fs, "recency_score": rs, "combined_score": fs + rs}
        valid.append(item)
    valid.sort(key=lambda x: (-x["combined_score"], x["benchmark"]["days_ago"], x["benchmark"]["followers"], -x["benchmark"]["likes"], x["primary_benchmark_index"]))
    if not valid:
        return {"primary_benchmark_index": None, "reason": "no_valid_benchmark"}
    result = valid[0]
    result["has_valid_low_follower_benchmark"] = any(x["benchmark"]["followers"] <= rules["absolute_followers_max"] for x in valid)
    return result


if __name__ == "__main__":
    if "--help" in sys.argv:
        print(__doc__)
    else:
        try:
            write_output(select(read_input()))
        except (ValueError, KeyError, TypeError) as exc:
            write_output({"error": str(exc)})
            raise SystemExit(2)
