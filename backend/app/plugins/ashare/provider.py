"""Tencent-first, Sina-fallback provider for raw daily A-share bars."""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import httpx
import polars as pl

from .tdx_minute import fetch_minute as _fetch_tdx_minute

logger = logging.getLogger(__name__)

_REQUEST_INTERVAL = 0.08
_TIMEOUT_S = 8.0
_BATCH_SIZE = 50
_RATE_LOCK = threading.Lock()
_NEXT_REQUEST_AT = 0.0


@dataclass
class _AshareConfig:
    datasets: dict = field(default_factory=lambda: {"daily": None, "minute": None})


def _pace() -> None:
    global _NEXT_REQUEST_AT
    with _RATE_LOCK:
        delay = _NEXT_REQUEST_AT - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        _NEXT_REQUEST_AT = time.monotonic() + _REQUEST_INTERVAL


def _get_json(url: str):
    _pace()
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 TickStockPanel/1.0"})
    with urlopen(request, timeout=_TIMEOUT_S) as response:
        return json.loads(response.read().decode("utf-8"))


def _vendor_symbol(symbol: str) -> str:
    code, dot, exchange = symbol.upper().partition(".")
    if not dot or exchange not in {"SH", "SZ", "BJ"} or not code.isdigit():
        raise ValueError(f"不支持的 Ashare 证券代码: {symbol}")
    return f"{exchange.lower()}{code}"


def _window(start_time: datetime | None, end_time: datetime | None) -> tuple[date, date, int]:
    end = (end_time or datetime.now()).date()
    start = (start_time or (end_time or datetime.now()) - timedelta(days=365)).date()
    span = max(1, (end - start).days + 1)
    count = min(10000, max(30, math.ceil(span * 7 / 5) + 20))
    return start, end, count


def _normal_rows(symbol: str, rows, *, source: str, start: date, end: date) -> list[dict]:
    out = []
    for row in rows or []:
        try:
            if source == "tencent":
                raw_date, opn, close, high, low, volume = row[:6]
            else:
                raw_date, opn, high, low, close, volume = (
                    row.get("day"), row.get("open"), row.get("high"), row.get("low"),
                    row.get("close"), row.get("volume"),
                )
            day = date.fromisoformat(str(raw_date)[:10])
            if not start <= day <= end:
                continue
            values = [float(opn), float(high), float(low), float(close), float(volume)]
            if not all(math.isfinite(value) for value in values) or values[4] < 0:
                continue
            out.append({
                "symbol": symbol,
                "date": day,
                "open": values[0],
                "high": values[1],
                "low": values[2],
                "close": values[3],
                # Tencent and Sina expose volume in shares; the repository stores hands.
                "volume": math.floor(values[4] / 100),
                "amount": None,
            })
        except (TypeError, ValueError, IndexError):
            continue
    return out


def _fetch_tencent(symbol: str, start: date, end: date, count: int) -> list[dict]:
    vendor_code = _vendor_symbol(symbol)
    params = f"{vendor_code},day,,{end.isoformat()},{count}"
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urlencode({"param": params})
    payload = _get_json(url)
    data = payload.get("data", {}).get(vendor_code, {})
    # Use the unadjusted `day` series. qfqday would conflict with local adjustment factors.
    return _normal_rows(symbol, data.get("day"), source="tencent", start=start, end=end)


def _fetch_sina(symbol: str, start: date, end: date, count: int) -> list[dict]:
    vendor_code = _vendor_symbol(symbol)
    url = "http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?" + urlencode({
        "symbol": vendor_code,
        "scale": "240",
        "ma": "5",
        "datalen": str(count),
    })
    payload = _get_json(url)
    return _normal_rows(symbol, payload, source="sina", start=start, end=end)


def _beijing_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)


def _parse_minute_datetime(value) -> datetime | None:
    text = str(value or "").strip()
    try:
        if len(text) == 12 and text.isdigit():
            return datetime.strptime(text, "%Y%m%d%H%M")
        return datetime.fromisoformat(text.replace("T", " "))
    except ValueError:
        return None


def _minute_rows(symbol: str, rows, *, source: str, start: datetime | None, end: datetime | None) -> list[dict]:
    out = []
    for row in rows or []:
        try:
            if source == "tencent":
                values = row.get("value", row) if isinstance(row, dict) else row
                dt = _parse_minute_datetime(values[0])
                opn, close, high, low, volume = map(float, values[1:6])
            else:
                dt = _parse_minute_datetime(row.get("day"))
                opn, high, low, close, volume = map(
                    float, (row.get("open"), row.get("high"), row.get("low"),
                            row.get("close"), row.get("volume")),
                )
            if dt is None or (start is not None and dt < start) or (end is not None and dt > end):
                continue
            if not all(math.isfinite(value) for value in (opn, close, high, low, volume)) or volume < 0:
                continue
            out.append({
                "symbol": symbol,
                "datetime": dt,
                "open": opn,
                "high": high,
                "low": low,
                "close": close,
                # Follow the Ashare minute endpoint's native volume unit (手).
                "volume": volume,
                "amount": None,
            })
        except (AttributeError, IndexError, TypeError, ValueError):
            continue
    return out


def _fetch_tencent_minute(
    symbol: str, start: datetime | None, end: datetime | None, count: int,
) -> list[dict]:
    vendor_code = _vendor_symbol(symbol)
    url = "https://ifzq.gtimg.cn/appstock/app/kline/mkline?" + urlencode({
        "param": f"{vendor_code},m1,,{count}",
    })
    payload = _get_json(url)
    rows = payload.get("data", {}).get(vendor_code, {}).get("m1", [])
    return _minute_rows(symbol, rows, source="tencent", start=start, end=end)


def _fetch_sina_minute(
    symbol: str, start: datetime | None, end: datetime | None, count: int,
) -> list[dict]:
    vendor_code = _vendor_symbol(symbol)
    url = "http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?" + urlencode({
        "symbol": vendor_code,
        "scale": "1",
        "ma": "5",
        "datalen": str(count),
    })
    payload = _get_json(url)
    return _minute_rows(symbol, payload, source="sina", start=start, end=end)


def _get_eastmoney_json(url: str):
    _pace()
    response = httpx.get(url, timeout=_TIMEOUT_S, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/",
    })
    response.raise_for_status()
    return response.json()


def _fetch_eastmoney_minute(
    symbol: str, start: datetime | None, end: datetime | None,
) -> list[dict]:
    code, dot, exchange = symbol.upper().partition(".")
    if not dot or exchange not in {"SH", "SZ", "BJ"} or len(code) != 6 or not code.isdigit():
        return []
    url = "https://push2his.eastmoney.com/api/qt/stock/trends2/get?" + urlencode({
        "secid": f"{1 if exchange == 'SH' else 0}.{code}",
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "ndays": "5",
        "iscr": "0",
    }, safe=",")
    payload = _get_eastmoney_json(url)
    data = payload.get("data") or {}
    if data.get("code") != code:
        return []
    result = []
    for row in data.get("trends") or []:
        try:
            fields = row.split(",")
            dt = _parse_minute_datetime(fields[0])
            opn, close, high, low, volume, amount = map(float, fields[1:7])
            if dt is None or (start and dt < start) or (end and dt > end):
                continue
            if not all(math.isfinite(v) for v in (opn, close, high, low, volume, amount)):
                continue
            if min(close, high, low) <= 0 or opn < 0 or volume < 0 or amount < 0:
                continue
            result.append({
                "symbol": symbol, "datetime": dt, "open": opn if opn > 0 else None, "high": high,
                "low": low, "close": close, "volume": volume, "amount": amount,
            })
        except (AttributeError, IndexError, TypeError, ValueError):
            continue
    return result


class AshareProvider:
    """逐标的日线请求；其他数据集有意不实现，继续走其他路由。"""

    name = "ashare"
    builtin = True

    def __init__(self) -> None:
        self.config = _AshareConfig()

    def close(self) -> None:
        return None

    def iter_daily(
        self,
        symbols: list[str],
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        asset_type: str = "stock",
        on_chunk_done: Callable[[int, int], None] | None = None,
    ) -> Iterator[pl.DataFrame]:
        if asset_type not in {"stock", "etf", "index"}:
            raise ValueError(f"不支持的日线资产类型: {asset_type}")
        start, end, count = _window(start_time, end_time)
        unique_symbols = list(dict.fromkeys(symbols))
        chunks = [unique_symbols[i:i + _BATCH_SIZE] for i in range(0, len(unique_symbols), _BATCH_SIZE)]
        for chunk_index, chunk in enumerate(chunks):
            records: list[dict] = []
            for symbol in chunk:
                try:
                    rows = _fetch_tencent(symbol, start, end, count)
                except Exception as exc:  # noqa: BLE001 — try the independent Sina endpoint
                    logger.info("Tencent 日线请求失败 %s，尝试新浪: %s", symbol, type(exc).__name__)
                    rows = []
                if not rows:
                    try:
                        rows = _fetch_sina(symbol, start, end, count)
                    except Exception as exc:
                        raise RuntimeError(
                            f"Ashare 日线获取失败 ({symbol}): Tencent 与 Sina 均不可用"
                        ) from exc
                if not rows:
                    raise RuntimeError(f"Ashare 日线返回空数据 ({symbol})")
                records.extend(rows)
            if records:
                yield pl.DataFrame(records).unique(subset=["symbol", "date"], keep="last").sort(
                    ["symbol", "date"]
                )
            if on_chunk_done:
                on_chunk_done(chunk_index + 1, len(chunks))

    def get_daily(self, symbols: list[str], **kwargs) -> pl.DataFrame:
        frames = list(self.iter_daily(symbols, **kwargs))
        return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()

    def get_minute(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: str = "stock",
        freq: str = "1m",
        on_chunk_done: Callable[[int, int], None] | None = None,
    ) -> pl.DataFrame:
        if asset_type not in {"stock", "etf", "index"} or freq != "1m":
            return pl.DataFrame()
        start, end = _beijing_naive(start_time), _beijing_naive(end_time)
        # Tencent silently falls back to 320 bars when the requested count exceeds 800.
        count = 800
        frames = []
        unique_symbols = list(dict.fromkeys(symbols))
        for index, symbol in enumerate(unique_symbols):
            try:
                rows = _fetch_tencent_minute(symbol, start, end, count)
            except Exception as exc:  # noqa: BLE001 — use the independent Sina endpoint
                logger.info("Tencent 分钟K请求失败 %s，尝试新浪: %s", symbol, type(exc).__name__)
                rows = []
            if not rows:
                try:
                    rows = _fetch_sina_minute(symbol, start, end, count)
                except Exception as exc:  # noqa: BLE001 — retain an empty result for this symbol
                    logger.info("Sina 分钟K请求失败 %s: %s", symbol, type(exc).__name__)
            if not rows and asset_type == "stock":
                try:
                    rows = _fetch_eastmoney_minute(symbol, start, end)
                except Exception as exc:  # noqa: BLE001 - preserve other sources
                    logger.info("Eastmoney minute request failed %s: %s", symbol, exc)
            if not rows and asset_type == "stock":
                try:
                    rows = _fetch_tdx_minute(symbol, start, end)
                except Exception as exc:  # noqa: BLE001 - preserve other sources
                    logger.info("Public TDX minute request failed %s: %s", symbol, exc)
            if rows:
                frames.append(pl.DataFrame(rows))
            if on_chunk_done:
                on_chunk_done(index + 1, len(unique_symbols))
        return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()
