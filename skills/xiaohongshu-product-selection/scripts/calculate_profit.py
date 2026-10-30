#!/usr/bin/env python3
"""Read price JSON from stdin (or a JSON file argument) and calculate profit."""
import sys
from common import nonnegative_number, read_input, write_output


def calculate(data):
    sale = nonnegative_number(data.get("sale_price"), "sale_price", positive=True)
    purchase = nonnegative_number(data.get("purchase_price"), "purchase_price")
    shipping = nonnegative_number(data.get("shipping_cost"), "shipping_cost")
    gross = sale - purchase - shipping
    margin = gross / sale
    return {"gross_profit": round(gross, 2), "profit_margin": margin, "profit_margin_display": f"{margin:.1%}"}


if __name__ == "__main__":
    if "--help" in sys.argv:
        print(__doc__)
    else:
        try:
            write_output(calculate(read_input()))
        except (ValueError, KeyError, TypeError) as exc:
            write_output({"error": str(exc)})
            raise SystemExit(2)
