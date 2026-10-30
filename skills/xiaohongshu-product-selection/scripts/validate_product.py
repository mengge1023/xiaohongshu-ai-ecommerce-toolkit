#!/usr/bin/env python3
"""Validate a product, applying hard failures before conditional execution failures."""
import sys
from calculate_profit import calculate as calculate_profit
from common import load_config, nonnegative_number, read_input, write_output
from select_primary_benchmark import select


REQUIRED = ["sales_total", "cart_24h", "benchmarks", "sale_price", "purchase_price", "shipping_cost", "material_level"]


def validate(data, config=None):
    cfg = config or load_config()
    result = {"hard_fail": False, "hard_fail_reason": None, "flags": [], "missing_fields": []}
    sales = data.get("sales_total")
    if sales is not None:
        sales = nonnegative_number(sales, "sales_total")
        if sales > cfg["sales"]["absolute_max"]:
            result.update(hard_fail=True, hard_fail_reason="sales_over_11000")
            return result
    cart = data.get("cart_24h")
    if cart is not None:
        cart = nonnegative_number(cart, "cart_24h")
        if cart < cfg["cart_24h"]["absolute_min"]:
            result.update(hard_fail=True, hard_fail_reason="cart_below_200")
            return result
    for field in REQUIRED:
        if data.get(field) is None or (field == "benchmarks" and not data.get(field)):
            result["missing_fields"].append(field)
    if data.get("benchmarks"):
        primary = select(data, cfg)
        result["primary_benchmark"] = primary
        if primary["primary_benchmark_index"] is None or not primary.get("has_valid_low_follower_benchmark"):
            result.update(hard_fail=True, hard_fail_reason="no_valid_low_follower_benchmark")
            return result
    if all(data.get(k) is not None for k in ("sale_price", "purchase_price", "shipping_cost")):
        profit = calculate_profit(data)
        result["profit"] = profit
        if profit["profit_margin"] < cfg["profit"]["absolute_min_margin"]:
            result["flags"].append("profit_source_not_ready")
    material = data.get("material_level")
    if material is not None:
        material = str(material).upper()
        if material not in cfg["material"]:
            raise ValueError("material_level must be A, B, or C")
        if material == "C":
            result["flags"].append("material_source_too_difficult")
    return result


if __name__ == "__main__":
    if "--help" in sys.argv:
        print(__doc__)
    else:
        try:
            write_output(validate(read_input()))
        except (ValueError, KeyError, TypeError) as exc:
            write_output({"error": str(exc)})
            raise SystemExit(2)
