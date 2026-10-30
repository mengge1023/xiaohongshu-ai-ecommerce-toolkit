import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_config():
    return json.loads((ROOT / "config" / "thresholds.json").read_text(encoding="utf-8"))


def read_input():
    import sys
    if len(sys.argv) > 1 and sys.argv[1] not in {"-", "--help"}:
        return json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    return json.load(sys.stdin)


def write_output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def nonnegative_number(value, name, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if value < 0 or (positive and value <= 0):
        raise ValueError(f"{name} must be {'positive' if positive else 'non-negative'}")
    return value


def upper_bound_score(value, bands, default=0):
    for maximum, score in bands:
        if value <= maximum:
            return score
    return default


def lower_bound_score(value, bands, default=0):
    score = default
    for minimum, band_score in bands:
        if value >= minimum:
            score = band_score
    return score
