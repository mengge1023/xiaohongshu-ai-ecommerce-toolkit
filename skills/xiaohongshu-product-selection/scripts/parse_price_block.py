#!/usr/bin/env python3
"""Parse only the DOM-verified WorkBuddy WebFetch goods-header template.

Input JSON: {"text": "verbatim WebFetch result", "source_url": "original URL"}.
No networking, browser, credentials or third-party dependencies.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import re
import sys
from urllib.parse import urlsplit, urlunsplit

HEADER = re.compile(
    r'\A\s*\*\*标题\*\*[:：]\s*(?:商品详情|小红书)\s+'
    r'[¥￥]\s*(?P<price>\d+(?:\.\d{1,2})?)\s+'
    r'(?P<label>到手价|券后价)\s*[¥￥]\s*(?P<reference>\d+(?:\.\d{1,2})?)\s+'
    r'已售\s*(?P<sales>\d+(?:\.\d+)?(?:万|千)?\+?)\s*(?=\n|\Z)'
)
HOSTS = {'xhslink.com', 'www.xhslink.com', 'xiaohongshu.com', 'www.xiaohongshu.com'}


def parse(data):
    text, url = data.get('text'), data.get('source_url')
    if not isinstance(text, str) or not isinstance(url, str):
        raise ValueError('text and source_url must be strings')
    parts = urlsplit(url)
    result = {
        'matched': False, 'reason': 'unsupported_template',
        'source_url': urlunsplit((parts.scheme, parts.netloc, parts.path, '', '')),
        'parsed_at': datetime.now(timezone.utc).isoformat(),
        'sale_price': None, 'reference_price': None, 'sales_total': None,
        'sales_raw': None, 'price_label': None, 'raw_price_block': None,
        'method': 'workbuddy_webfetch_goods_header_v1',
    }
    if parts.scheme not in ('http', 'https') or parts.hostname not in HOSTS or parts.username:
        result['reason'] = 'unsupported_source'
        return result
    if len(text) > 200000:
        result['reason'] = 'input_too_large'
        return result
    match = HEADER.match(text)
    if not match:
        return result
    price, reference = Decimal(match['price']), Decimal(match['reference'])
    if price <= 0 or reference < price:
        result['reason'] = 'inconsistent_price_block'
        return result
    raw_sales = match['sales']
    exact_sales = int(raw_sales) if raw_sales.isascii() and raw_sales.isdecimal() else None
    result.update(
        matched=True, reason='recognized_dom_verified_template',
        sale_price=float(price), reference_price=float(reference),
        sales_total=exact_sales, sales_raw=raw_sales,
        price_label=match['label'], raw_price_block=match[0].strip(),
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        result = parse(json.load(sys.stdin))
    except (ValueError, TypeError, AttributeError) as exc:
        print(json.dumps({'matched': False, 'reason': 'invalid_input', 'error': str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
