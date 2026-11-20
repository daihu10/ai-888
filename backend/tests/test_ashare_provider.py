from datetime import date, datetime

import polars as pl
import pytest

from app.plugins.ashare import provider as ashare


def test_tencent_daily_is_normalized_and_filtered(monkeypatch):
    monkeypatch.setattr(
        ashare,
        "_get_json",
        lambda _url: {"data": {"sh600000": {"day": [
            ["2026-11-12", "10", "11", "12", "9", "12345"],
            ["2026-11-13", "10", "11", "12", "9", "12345"],
        ]}}},
    )

    rows = ashare._fetch_tencent(
        "600000.SH", date(2026, 11, 13), date(2026, 11, 13), 30,
    )

    assert rows == [{
        "symbol": "600000.SH", "date": date(2026, 11, 13), "open": 10.0,
        "high": 12.0, "low": 9.0, "close": 11.0, "volume": 123,
        "amount": None,
    }]


def test_sina_fallback_when_tencent_fails(monkeypatch):
    calls = []

    def fetch(symbol, start, end, count):
        calls.append((symbol, count))
        if len(calls) == 1:
            raise OSError("Tencent unavailable")
        return [{
            "symbol": symbol, "date": date(2026, 11, 13), "open": 1.0,
            "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10,
            "amount": None,
        }]

    monkeypatch.setattr(ashare, "_fetch_tencent", fetch)
    monkeypatch.setattr(ashare, "_fetch_sina", fetch)
    frames = list(ashare.AshareProvider().iter_daily(
        ["600000.SH"], datetime(2026, 11, 13), datetime(2026, 11, 13),
    ))

    assert len(frames) == 1
    assert frames[0].schema["date"] == pl.Date
    assert calls == [("600000.SH", 30), ("600000.SH", 30)]


def test_sina_failure_is_surfaced_without_partial_frame(monkeypatch):
    def fetch_tencent(symbol, *_args):
        if symbol == "000001.SZ":
            raise OSError("Tencent unavailable")
        return [{"symbol": symbol, "date": date(2026, 11, 13),
                 "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                 "volume": 1, "amount": None}]

    monkeypatch.setattr(ashare, "_fetch_tencent", fetch_tencent)

    def fail(*_args):
        raise OSError("Sina unavailable")

    monkeypatch.setattr(ashare, "_fetch_sina", fail)
    with pytest.raises(RuntimeError) as error:
        list(ashare.AshareProvider().iter_daily(
            ["600000.SH", "000001.SZ"], datetime(2026, 11, 13), datetime(2026, 11, 13),
        ))
    assert "000001.SZ" in str(error.value)


def test_provider_only_declares_daily_capability():
    from app.data_providers import custom

    custom.load_all()
    assert custom.provider_has_dataset("ashare", "daily")
    assert not custom.provider_has_dataset("ashare", "realtime")
    assert custom.provider_has_dataset("ashare", "minute")


def test_minute_rows_are_filtered_and_normalized_to_beijing_wallclock():
    rows = ashare._minute_rows(
        "600519.SH",
        [
            {"value": ["202611131429", "10", "12", "13", "9", "20"]},
            {"value": ["202611131430", "10", "12", "13", "9", "20"]},
        ],
        source="tencent",
        start=datetime(2026, 11, 13, 14, 30),
        end=datetime(2026, 11, 13, 15, 5),
    )

    assert rows == [{
        "symbol": "600519.SH", "datetime": datetime(2026, 11, 13, 14, 30),
        "open": 10.0, "high": 13.0, "low": 9.0, "close": 12.0,
        "volume": 20.0, "amount": None,
    }]


def test_minute_fetch_falls_back_to_sina_when_tencent_has_no_selected_day(monkeypatch):
    monkeypatch.setattr(ashare, "_fetch_tencent_minute", lambda *_args: [])
    monkeypatch.setattr(
        ashare,
        "_fetch_sina_minute",
        lambda symbol, *_args: [{
            "symbol": symbol, "datetime": datetime(2026, 11, 13, 14, 30),
            "open": 10.0, "high": 13.0, "low": 9.0, "close": 12.0,
            "volume": 20.0, "amount": None,
        }],
    )

    frame = ashare.AshareProvider().get_minute(
        ["600519.SH"], datetime(2026, 11, 13, 9, 25), datetime(2026, 11, 13, 15, 5),
    )

    assert frame.height == 1
    assert frame["datetime"].to_list() == [datetime(2026, 11, 13, 14, 30)]


@pytest.mark.parametrize("symbol", ["601566.SH", "920202.BJ"])
def test_eastmoney_minute_filters_date_and_bad_prices(monkeypatch, symbol):
    monkeypatch.setattr(ashare, "_get_eastmoney_json", lambda _url: {"data": {
        "code": symbol[:6], "trends": [
            "2026-11-10 09:30,0,10,10,10,5,50,10",
            "2026-11-10 09:31,10,11,12,9,5,500,10",
            "2026-11-11 09:31,10,11,12,9,5,500,10",
        ],
    }})
    rows = ashare._fetch_eastmoney_minute(symbol, datetime(2026, 11, 10), datetime(2026, 11, 10, 15))
    assert len(rows) == 2
    assert rows[0]["open"] is None
    assert rows[1]["datetime"] == datetime(2026, 11, 10, 9, 31)
    assert rows[1]["volume"] == 5
    assert rows[1]["amount"] == 500
