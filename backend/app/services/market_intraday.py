"""东方财富公开指数分时：仅返回请求日期，免费接口历史深度由上游决定。"""
from datetime import date
from functools import lru_cache
import math
import time

import httpx

_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'


def parse_trends(data: dict, day: date) -> list[dict]:
    result = []
    for item in data.get('trends', []):
        try:
            fields = item.split(',')
            stamp = fields[0]
            price = float(fields[2])
            if stamp[:10] != day.isoformat() or len(stamp) != 16 or not math.isfinite(price) or price <= 0:
                continue
            result.append({'time': stamp[11:16], 'price': price})
        except (ValueError, IndexError, AttributeError):
            continue
    return sorted(result, key=lambda row: row['time'])


@lru_cache(maxsize=64)
def _fetch(day: date, cache_slot: int) -> tuple[dict, ...]:
    response = httpx.get(_URL, params={
        'secid': '1.000001', 'fields1': 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58', 'iscr': '0', 'ndays': '5',
    }, timeout=8.0, follow_redirects=True)
    response.raise_for_status()
    payload = response.json()
    if payload.get('rc') != 0 or not isinstance(payload.get('data'), dict):
        raise ValueError('东方财富返回了无效数据')
    return tuple(parse_trends(payload['data'], day))


def index_trends(day: date) -> list[dict]:
    return list(_fetch(day, int(time.time() // 30)))
