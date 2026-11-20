from datetime import datetime

import pytest

from app.plugins.ashare import provider, tdx_minute


@pytest.mark.parametrize(("symbol", "market"), [("600519.SH", 1), ("000001.SZ", 0), ("920202.BJ", 0)])
def test_public_tdx_routes_and_filters(monkeypatch, symbol, market):
    calls = []

    class Api:
        def __init__(self, **kwargs):
            pass

        def connect(self, *args, **kwargs):
            return True

        def disconnect(self):
            pass

        def get_security_bars(self, category, actual_market, code, offset, count):
            calls.append((category, actual_market, code, offset, count))
            return [dict(datetime=day, open=10, high=11, low=9, close=10, vol=20, amount=2000)
                    for day in ("2026-11-12 09:31", "2026-11-13 09:31")]

    monkeypatch.setattr(tdx_minute, "TdxHq_API", Api)
    rows = tdx_minute.fetch_minute(symbol, datetime(2026, 11, 13), datetime(2026, 11, 13, 15))
    assert calls == [(8, market, symbol[:6], 0, 800)]
    assert len(rows) == 1
    assert rows[0]["datetime"] == datetime(2026, 11, 13, 9, 31)
    assert rows[0]["volume"] == 20


def test_public_tdx_retries_host_and_pages(monkeypatch):
    calls = []

    class Api:
        def __init__(self, **kwargs):
            pass

        def connect(self, host, *args, **kwargs):
            if host == "bad":
                raise OSError("offline")
            return True

        def disconnect(self):
            pass

        def get_security_bars(self, category, market, code, offset, count):
            calls.append(offset)
            dt = "2026-11-13 09:31" if offset == 0 else "2026-11-05 09:31"
            return [dict(datetime=dt, open=10, high=11, low=9, close=10, vol=20, amount=2000)] * (800 if offset == 0 else 1)

    monkeypatch.setattr(tdx_minute, "_HOSTS", (("bad", 1), ("good", 1)))
    monkeypatch.setattr(tdx_minute, "TdxHq_API", Api)
    rows = tdx_minute.fetch_minute("600519.SH", datetime(2026, 11, 5), datetime(2026, 11, 5, 15))
    assert calls == [0, 800]
    assert len(rows) == 1


def test_ashare_uses_public_tdx_after_primary_sources(monkeypatch):
    monkeypatch.setattr(provider, "_fetch_tencent_minute", lambda *_: [])
    monkeypatch.setattr(provider, "_fetch_sina_minute", lambda *_: [])
    monkeypatch.setattr(provider, "_fetch_eastmoney_minute", lambda *_: [])
    monkeypatch.setattr(provider, "_fetch_tdx_minute", lambda symbol, *_: [dict(
        symbol=symbol, datetime=datetime(2026, 11, 13, 9, 31), open=10, high=11,
        low=9, close=10, volume=20, amount=2000,
    )])
    frame = provider.AshareProvider().get_minute(["920202.BJ"], datetime(2026, 11, 13), datetime(2026, 11, 13, 15))
    assert frame.height == 1
