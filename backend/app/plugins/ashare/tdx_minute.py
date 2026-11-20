"""Best-effort minute bars from public Tongdaxin quotation servers."""
from __future__ import annotations

import logging
import math
from datetime import datetime

from pytdx.hq import TdxHq_API

logger = logging.getLogger(__name__)

_HOSTS = (("180.153.18.170", 7709), ("60.191.117.167", 7709))
_PAGE_SIZE = 800
_MAX_PAGES = 12


def fetch_minute(symbol: str, start: datetime | None, end: datetime | None) -> list[dict]:
    code, dot, exchange = symbol.upper().partition(".")
    if not dot or exchange not in {"SH", "SZ", "BJ"} or len(code) != 6 or not code.isdigit():
        return []
    market = 1 if exchange == "SH" else 0
    for host, port in _HOSTS:
        api = TdxHq_API(raise_exception=True)
        try:
            if not api.connect(host, port, time_out=2):
                continue
            result = []
            for page in range(_MAX_PAGES):
                bars = api.get_security_bars(8, market, code, page * _PAGE_SIZE, _PAGE_SIZE)
                if not bars:
                    break
                dates = []
                for bar in bars:
                    try:
                        dt = datetime.fromisoformat(bar["datetime"])
                        dates.append(dt)
                        values = [float(bar[k]) for k in ("open", "high", "low", "close", "vol", "amount")]
                        if not all(math.isfinite(v) for v in values) or values[4] < 0:
                            continue
                        if (start and dt < start) or (end and dt > end):
                            continue
                        result.append(dict(zip(
                            ("symbol", "datetime", "open", "high", "low", "close", "volume", "amount"),
                            (symbol, dt, *values), strict=True,
                        )))
                    except (KeyError, TypeError, ValueError):
                        continue
                if not dates or (start and min(dates) <= start) or len(bars) < _PAGE_SIZE:
                    break
            if result:
                return result
        except Exception as exc:  # noqa: BLE001 - public hosts may be unavailable
            logger.info("Public TDX minute request failed for %s at %s: %s", symbol, host, exc)
        finally:
            try:
                api.disconnect()
            except Exception as exc:  # noqa: BLE001 - cleanup must not mask fallback
                logger.debug("Public TDX disconnect failed: %s", exc)
    return []
