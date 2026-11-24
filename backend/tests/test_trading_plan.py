from __future__ import annotations

import json
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.trading_plan import router
from app.config import settings
from app.market_time import CN_TZ
from app.services import trading_plan as plans
from app.services.quote_freshness import QuoteFreshness


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.mark.parametrize("verdict", [True, False, None])
def test_calendar_includes_today_without_regime_record_only_when_confirmed(client, monkeypatch, verdict):
    from app.services import data_integrity, regime_builder, trading_day

    monkeypatch.setattr(plans, "cn_now", lambda: datetime(2026, 11, 23, 9, 0, tzinfo=CN_TZ))
    monkeypatch.setattr(regime_builder, "load_regime_history", lambda _: pl.DataFrame({"date": [date(2026, 11, 20)]}))
    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: None)
    monkeypatch.setattr(trading_day, "is_trading_day", lambda _: verdict)
    response = client.get("/api/custom/trading-plan/calendar?year=2026")
    assert response.status_code == 200
    result = response.json()
    assert result["dates"] == (["2026-11-20", "2026-11-23"] if verdict else ["2026-11-20"])
    assert result["today_is_trading"] is verdict
    assert result["previous"] == "2026-11-20"
    assert result["latest"] == ("2026-11-23" if verdict else "2026-11-20")


def test_calendar_skips_holidays_future_dates_and_keeps_previous_year_navigation(client, monkeypatch):
    from app.services import data_integrity, regime_builder, trading_day

    monkeypatch.setattr(plans, "cn_now", lambda: datetime(2027, 1, 4, 10, 0, tzinfo=CN_TZ))
    monkeypatch.setattr(regime_builder, "load_regime_history", lambda _: pl.DataFrame())
    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: {
        date(2026, 12, 31), date(2027, 1, 4), date(2027, 1, 5), date(2027, 2, 1),
    })
    monkeypatch.setattr(trading_day, "is_trading_day", lambda _: True)
    result = client.get("/api/custom/trading-plan/calendar?year=2027").json()
    assert result["dates"] == ["2027-01-04"]
    assert result["previous"] == "2026-12-31"
    assert result["latest"] == "2027-01-04"
    assert client.get("/api/custom/trading-plan/calendar?year=2026").json()["dates"] == ["2026-12-31"]
    assert client.get("/api/custom/trading-plan/calendar?year=2028").json()["dates"] == []


def test_calendar_weekend_empty_and_unavailable(client, monkeypatch):
    from app.services import data_integrity, regime_builder, trading_day

    monkeypatch.setattr(plans, "cn_now", lambda: datetime(2026, 11, 22, 10, 0, tzinfo=CN_TZ))
    monkeypatch.setattr(regime_builder, "load_regime_history", lambda _: pl.DataFrame())
    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: None)
    monkeypatch.setattr(trading_day, "is_trading_day", lambda _: False)
    result = client.get("/api/custom/trading-plan/calendar?year=2026").json()
    assert result["dates"] == []
    assert result["previous"] is None
    assert result["latest"] is None
    assert result["today_is_trading"] is False
    assert client.get("/api/custom/trading-plan/calendar?year=0").status_code == 422
    monkeypatch.setattr(plans, "plan_calendar", Mock(side_effect=OSError()))
    assert client.get("/api/custom/trading-plan/calendar?year=2026").status_code == 503


def test_daily_roundtrip_and_average(client):
    url = "/api/custom/trading-plan/2026-11-19"
    empty = client.get(url).json()
    assert empty["revision"] is None
    assert empty["overall_score"] is None
    assert client.get("/api/custom/trading-plan").json() == {"dates": []}
    payload = {
        "market_above_ma5": True,
        "matches_mode": True,
        "holdings": [
            {"symbol": "600000.SH", "name": "浦发银行", "above_ma5": False,
             "above_ma10": True, "above_ma20": False,
             "reason": "等待突破", "tomorrow_plan": "回踩5日线加仓", "plan_followed": False,
             "stop_loss": "跌破10元"},
            {"symbol": "000001.SZ", "name": "平安银行", "above_ma5": True},
        ],
        "highest_board_count": 5, "limit_up_count": 60, "limit_down_count": 12,
        "core_theme": "机器人", "secondary_theme": "芯片",
        "holding_execution": "按计划减仓", "target_stocks": "关注银行板块",
        "execution_review": {"answer": True, "score": 10},
        "ma5_review": {"answer": True, "reason": "等待突破", "stop_loss": "跌破10元", "score": 8},
        "ma20_review": {"answer": False, "score": 7},
        "self_assessment": "计划执行偏差：追高买入，下次等待回踩确认。",
    }
    response = client.put(url, json=payload)
    assert response.status_code == 200
    saved = response.json()
    assert saved["overall_score"] == 8.3
    assert saved["limit_down_count"] == 12
    assert saved["updated_at"].endswith("+08:00")
    assert saved["holdings"][0]["stop_loss"] == "跌破10元"
    assert saved["holdings"][0]["tomorrow_plan"] == "回踩5日线加仓"
    assert saved["holdings"][0]["plan_followed"] is False
    assert saved["holdings"][1]["tomorrow_plan"] == ""
    assert saved["holdings"][1]["plan_followed"] is None
    assert saved["holdings"][0]["above_ma10"] is True
    assert saved["holdings"][0]["above_ma20"] is False
    assert saved["holdings"][1]["above_ma10"] is None
    assert saved["self_assessment"] == "计划执行偏差：追高买入，下次等待回踩确认。"
    assert client.get(url).json() == saved
    assert plans.get_plan(date(2026, 11, 19)).model_dump(mode="json") == saved
    assert client.get("/api/custom/trading-plan/2026-11-20").json()["holdings"] == []
    assert client.get("/api/custom/trading-plan").json() == {"dates": ["2026-11-19"]}
    payload["revision"] = saved["revision"]
    payload["core_theme"] = "算力"
    updated = client.put(url, json=payload).json()
    assert updated["core_theme"] == "算力"
    assert updated["revision"] != saved["revision"]
    assert client.put(url, json=payload).status_code == 409
    assert client.get(url).json() == updated


@pytest.mark.parametrize("field,value", [
    ("highest_board_count", -1), ("limit_up_count", 1.5),
    ("limit_down_count", -1), ("limit_down_count", 10001),
    ("limit_down_count", 1.5), ("limit_down_count", True),
    ("market_above_ma5", "yes"),
    ("holding_execution_followed", "yes"), ("target_stocks_followed", 0),
    ("market_sentiment", "牛市"), ("market_sentiment", True),
    ("execution_review", {"score": 0}), ("ma5_review", {"score": 11}),
    ("ma20_review", {"score": 2.5}), ("execution_review", {"score": True}),
    ("holdings", [{"symbol": "../../secret", "name": "错误"}]),
    ("holdings", [{"symbol": "600000.SH", "name": "浦发"}] * 2),
    ("holdings", [{"symbol": "600000.SH", "name": "浦发", "above_ma10": "yes"}]),
    ("holdings", [{"symbol": "600000.SH", "name": "浦发", "above_ma20": 1}]),
    ("holdings", [{"symbol": "600000.SH", "name": "浦发", "plan_followed": "yes"}]),
    ("holdings", [{"symbol": "600000.SH", "name": "浦发", "tomorrow_plan": "x" * 5001}]),
    ("core_theme", "x" * 501), ("overall_score", 10),
])
def test_invalid_input_is_not_saved(client, field, value):
    response = client.put("/api/custom/trading-plan/2026-11-19", json={field: value})
    assert response.status_code == 422
    assert client.get("/api/custom/trading-plan").json() == {"dates": []}


def test_partial_scores_and_date_validation(client):
    result = client.put("/api/custom/trading-plan/2026-11-19", json={
        "execution_review": {"score": 1}, "ma5_review": {"score": 10},
    })
    assert result.status_code == 200
    assert result.json()["overall_score"] is None
    assert client.get("/api/custom/trading-plan/2026-02-30").status_code == 422
    assert client.put("/api/custom/trading-plan/2026-11-20", json={"revision": "stale"}).status_code == 409


@pytest.mark.parametrize("content", ["{broken", '{"schema_version":2}', '{"date":"2026-11-20"}'])
def test_corrupt_or_future_data_cannot_be_overwritten(client, content):
    folder = settings.data_dir / "user_data" / "trading_plans"
    folder.mkdir(parents=True)
    path = folder / "2026-11-19.json"
    path.write_text(content, encoding="utf-8")
    url = "/api/custom/trading-plan/2026-11-19"
    assert client.get(url).status_code == 409
    assert client.put(url, json={}).status_code == 409
    assert path.read_text(encoding="utf-8") == content


def test_failed_atomic_write_preserves_previous_plan(client, monkeypatch):
    url = "/api/custom/trading-plan/2026-11-19"
    saved = client.put(url, json={"core_theme": "原始内容"}).json()

    def fail(*args, **kwargs):
        raise PermissionError("private system path")

    monkeypatch.setattr(plans, "atomic_write_text", fail)
    response = client.put(url, json={"revision": saved["revision"], "core_theme": "新内容"})
    assert response.status_code == 503
    assert "private system path" not in response.text
    assert client.get(url).json() == saved
    stored = settings.data_dir / "user_data" / "trading_plans" / "2026-11-19.json"
    assert json.loads(stored.read_text(encoding="utf-8"))["core_theme"] == "原始内容"


def test_score_boundaries_partial_and_date_order(client):
    for day, score in [("2026-11-18", 1), ("2026-11-20", 10)]:
        review = {"score": score}
        saved = client.put(f"/api/custom/trading-plan/{day}", json={
            "execution_review": review, "ma5_review": review, "ma20_review": review,
        }).json()
        assert saved["overall_score"] == score
    partial = client.put("/api/custom/trading-plan/2026-11-19", json={
        "execution_review": {"score": 8}, "ma5_review": {"score": 9},
    }).json()
    assert partial["overall_score"] is None
    assert client.get("/api/custom/trading-plan").json()["dates"] == ["2026-11-20", "2026-11-19", "2026-11-18"]
    assert client.put("/api/custom/trading-plan/2026-02-30", json={}).status_code == 422


def test_year_scores_are_sorted_saved_only_and_refresh_after_edit(client):
    endpoint = "/api/custom/trading-plan/scores?year=2024"
    assert client.get(endpoint).json() == {"year": 2024, "rows": []}
    for day, values in [("2024-12-31", [9, 10, 10]), ("2024-02-29", [4, 5, 5]),
                        ("2023-12-31", [1, 1, 1]), ("2024-01-01", [8, None, 9])]:
        assert client.put(f"/api/custom/trading-plan/{day}", json={
            key: {"score": score} for key, score in zip(
                ("execution_review", "ma5_review", "ma20_review"), values, strict=True)
        }).status_code == 200
    folder = settings.data_dir / "user_data" / "trading_plans"
    (folder / "2024-02-30.json").write_text("invalid date ignored", encoding="utf-8")
    (folder / "2023-01-01.json").write_text("other year unreadable", encoding="utf-8")
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    assert client.get(endpoint).json() == {"year": 2024, "rows": [
        {"date": "2024-01-01", "overall_score": None},
        {"date": "2024-02-29", "overall_score": 4.7},
        {"date": "2024-12-31", "overall_score": 9.7},
    ]}
    assert {p.name: p.read_bytes() for p in folder.iterdir()} == before
    day_url = "/api/custom/trading-plan/2024-02-29"
    saved = client.get(day_url).json()
    assert client.put(day_url, json={"revision": saved["revision"], **{
        key: {"score": 10} for key in ("execution_review", "ma5_review", "ma20_review")
    }}).status_code == 200
    assert client.get(endpoint).json()["rows"][1]["overall_score"] == 10


@pytest.mark.parametrize("query", ["", "?year=0", "?year=10000", "?year=abc"])
def test_year_scores_validate_year(client, query):
    assert client.get(f"/api/custom/trading-plan/scores{query}").status_code == 422


def test_year_scores_report_corrupt_data_and_storage_failures(client, monkeypatch):
    folder = settings.data_dir / "user_data" / "trading_plans"
    folder.mkdir(parents=True)
    path = folder / "2026-11-19.json"
    path.write_text("{broken", encoding="utf-8")
    assert client.get("/api/custom/trading-plan/scores?year=2026").status_code == 409
    assert path.read_text(encoding="utf-8") == "{broken"
    monkeypatch.setattr(plans, "list_scores", Mock(side_effect=PermissionError("private system path")))
    response = client.get("/api/custom/trading-plan/scores?year=2026")
    assert response.status_code == 503
    assert "private system path" not in response.text


def test_old_plan_without_new_ma_fields_remains_editable(client):
    url = "/api/custom/trading-plan/2026-11-19"
    saved = client.put(url, json={"holdings": [{"symbol": "600000.SH", "name": "浦发银行"}]}).json()
    path = settings.data_dir / "user_data" / "trading_plans" / "2026-11-19.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored.pop("limit_down_count")
    stored.pop("holding_execution_followed")
    stored.pop("target_stocks_followed")
    stored.pop("market_sentiment")
    stored.pop("self_assessment")
    for key in ("above_ma10", "above_ma20", "tomorrow_plan", "plan_followed"):
        stored["holdings"][0].pop(key)
    path.write_text(json.dumps(stored), encoding="utf-8")
    loaded = client.get(url).json()
    assert loaded["limit_down_count"] is None
    assert loaded["holding_execution_followed"] is None
    assert loaded["target_stocks_followed"] is None
    assert loaded["market_sentiment"] is None
    assert loaded["self_assessment"] == ""
    assert loaded == saved
    assert client.put(url, json={"revision": saved["revision"], "holdings": loaded["holdings"]}).status_code == 200


@pytest.mark.parametrize("value", [None, 0, 10000])
def test_limit_down_count_boundaries_and_date_isolation(client, value):
    url = "/api/custom/trading-plan/2026-11-19"
    response = client.put(url, json={"limit_down_count": value})
    assert response.status_code == 200
    assert response.json()["limit_down_count"] == value
    assert client.get(url).json()["limit_down_count"] == value
    assert client.get("/api/custom/trading-plan/2026-11-18").json()["limit_down_count"] is None


@pytest.mark.parametrize("answer", [None, True, False])
def test_tomorrow_plan_execution_answers_roundtrip_and_date_isolation(client, answer):
    url = "/api/custom/trading-plan/2026-11-19"
    payload = {"holding_execution": "按计划减仓", "target_stocks": "观察银行",
               "holding_execution_followed": answer, "target_stocks_followed": answer}
    response = client.put(url, json=payload)
    assert response.status_code == 200
    loaded = client.get(url).json()
    for key, value in payload.items():
        assert loaded[key] == value
    other = client.get("/api/custom/trading-plan/2026-11-18").json()
    assert other["holding_execution_followed"] is None
    assert other["target_stocks_followed"] is None
    assert loaded["overall_score"] is None


@pytest.mark.parametrize("sentiment", [None, "强势", "震荡", "弱势"])
def test_market_sentiment_roundtrip_and_date_isolation(client, sentiment):
    url = "/api/custom/trading-plan/2026-11-19"
    response = client.put(url, json={"market_sentiment": sentiment})
    assert response.status_code == 200
    assert response.json()["market_sentiment"] == sentiment
    assert client.get(url).json()["market_sentiment"] == sentiment
    assert client.get("/api/custom/trading-plan/2026-11-18").json()["market_sentiment"] is None
    assert response.json()["overall_score"] is None


def test_quotes_use_raw_price_and_per_symbol_date_without_mutating_plans(client):
    calls = []

    def latest():
        calls.append(True)
        return pl.DataFrame({
            "symbol": ["600000.SH", "600000.SH", "000001.SZ", "600519.SH"],
            "date": [date(2026, 11, 17), date(2026, 11, 18), date(2026, 11, 18), date(2026, 11, 18)],
            "close": [8., 9., 10., 11.], "raw_close": [11., 12.36, None, float("nan")],
        }), date(2026, 11, 18)

    client.app.state.repo = SimpleNamespace(get_enriched_latest=latest)
    response = client.get("/api/custom/trading-plan/quotes?symbols=600000.SH,000001.SZ,600519.SH,000002.SZ,600000.SH")
    assert response.status_code == 200
    rows = response.json()["rows"]
    assert len(calls) == 1
    assert [row["price"] for row in rows] == [12.36, None, None, None]
    assert rows[0]["quote_freshness"]["data_date"] == "2026-11-18"
    assert rows[0]["quote_freshness"]["state"] != "live"
    assert all(row["quote_freshness"]["state"] == "missing" for row in rows[1:])
    assert client.get("/api/custom/trading-plan").json() == {"dates": []}


@pytest.mark.parametrize("symbols", ["../../secret", "600000", "600000.XX", ",", "600000.SH," ,
                                      ",".join(f"{n:06}.SH" for n in range(101))])
def test_quotes_reject_invalid_or_excess_symbols(client, symbols):
    assert client.get("/api/custom/trading-plan/quotes", params={"symbols": symbols}).status_code == 422


def test_quotes_without_repository_are_explicitly_missing(client):
    row = client.get("/api/custom/trading-plan/quotes?symbols=600000.SH").json()["rows"][0]
    assert row["price"] is None
    assert row["quote_freshness"]["state"] == "missing"


def test_plan_day_prices_batch_uses_exact_date_raw_close_without_touching_quotes(client):
    day = date(2026, 11, 18)
    read = Mock(return_value=pl.DataFrame({
        "symbol": ["600000.SH", "600000.SH", "000001.SZ", "000002.SZ"],
        "date": [day, date(2026, 11, 19), day, day],
        "raw_close": [11.25, 12.36, None, float("nan")], "close": [5., 6., 7., 8.],
    }))
    client.app.state.repo = SimpleNamespace(get_daily_batch=read)
    response = client.get("/api/custom/trading-plan/prices", params={
        "date": str(day), "symbols": "600000.SH,000001.SZ,000002.SZ,000003.SZ,600000.SH",
    })
    assert response.status_code == 200
    rows = response.json()["rows"]
    assert [row["price"] for row in rows] == [11.25, None, None, None]
    assert rows[0]["data_date"] == str(day)
    assert all(row["data_date"] is None for row in rows[1:])
    read.assert_called_once_with(["600000.SH", "000001.SZ", "000002.SZ", "000003.SZ"], day, day,
                                 columns=["symbol", "date", "raw_close"])
    assert client.get("/api/custom/trading-plan").json() == {"dates": []}


@pytest.mark.parametrize("frame", [pl.DataFrame(), pl.DataFrame({"symbol": ["600000.SH"], "date": [date(2026, 11, 18)], "close": [10.]}),
                                  pl.DataFrame({"symbol": ["600000.SH"], "date": [date(2026, 11, 19)], "raw_close": [12.]})])
def test_plan_day_price_missing_raw_or_nontrading_date_does_not_fall_back(client, frame):
    client.app.state.repo = SimpleNamespace(get_daily_batch=Mock(return_value=frame))
    row = client.get("/api/custom/trading-plan/prices?date=2026-11-18&symbols=600000.SH").json()["rows"][0]
    assert row == {"symbol": "600000.SH", "price": None, "data_date": None}


def test_plan_day_prices_validation_and_read_failure(client):
    assert client.get("/api/custom/trading-plan/prices?date=2026-02-30&symbols=600000.SH").status_code == 422
    assert client.get("/api/custom/trading-plan/prices?date=2026-11-18&symbols=../bad").status_code == 422
    client.app.state.repo = SimpleNamespace(get_daily_batch=Mock(side_effect=OSError("private path")))
    response = client.get("/api/custom/trading-plan/prices?date=2026-11-18&symbols=600000.SH")
    assert response.status_code == 503
    assert "private path" not in response.text


@pytest.fixture
def sync_market(client, monkeypatch):
    day = date(2026, 11, 19)
    now = datetime(2026, 11, 19, 10, 0, tzinfo=CN_TZ)
    monkeypatch.setattr(plans, "cn_today", lambda: day)
    monkeypatch.setattr(plans, "capability_gate", lambda _: (True, "测试实时源"))
    monkeypatch.setattr(QuoteFreshness, "for_request", lambda _: QuoteFreshness(now=now, trading=True))
    frame = pl.DataFrame({
        "symbol": ["600000.SH", "000001.SZ"], "date": [day, day],
        "raw_close": [10., 12.], "close": [5., 12.],
        "ma5": [6., 11.], "ma10": [5., 13.], "ma20": [4., None],
        "quote_ts": [int(now.timestamp() * 1000)] * 2,
    })
    repo = SimpleNamespace(get_enriched_latest=Mock(return_value=(frame, day)))
    qs = SimpleNamespace(status=Mock(return_value={"paused": False}),
                         subscribe_quotes=Mock(), unsubscribe_quotes=Mock(),
                         refresh=Mock(return_value={"updated": True}))
    client.app.state.repo, client.app.state.quote_service = repo, qs
    return day, repo, qs


def test_sync_refreshes_once_and_compares_adjusted_prices_without_saving_plan(client, sync_market):
    day, repo, qs = sync_market
    response = client.post("/api/custom/trading-plan/sync", json={
        "date": str(day), "symbols": ["600000.SH", "000001.SZ", "600000.SH"],
    })
    assert response.status_code == 200
    first, second = response.json()["rows"]
    assert first["price"] == 10.
    # 均线6为复权价，止损线必须换算回实际股价：6 * 10 / 5 = 12。
    assert first["ma5_price"] == 12.
    assert second["ma5_price"] == 11.
    # 原价10高于均线6，但前复权价格5低于均线6，必须判否；相等判是。
    assert [first[f"above_ma{n}"] for n in (5, 10, 20)] == [False, True, True]
    assert [second[f"above_ma{n}"] for n in (5, 10, 20)] == [True, False, None]
    assert "缺少20日均线" in second["issues"][0]
    qs.refresh.assert_called_once()
    repo.get_enriched_latest.assert_called_once()
    assert qs.subscribe_quotes.call_args.args[1] == ["600000.SH", "000001.SZ"]
    qs.unsubscribe_quotes.assert_called_once_with(qs.subscribe_quotes.call_args.args[0])
    assert client.get("/api/custom/trading-plan").json() == {"dates": []}


def test_sync_skips_old_misattributed_missing_and_future_quotes(client, sync_market):
    day, repo, _ = sync_market
    now = datetime(2026, 11, 19, 10, tzinfo=CN_TZ)
    yesterday = datetime(2026, 11, 18, 10, tzinfo=CN_TZ)
    future = datetime(2026, 11, 20, 10, tzinfo=CN_TZ)
    symbols = [f"{i:06}.SH" for i in range(5)]
    repo.get_enriched_latest.return_value = (pl.DataFrame({
        "symbol": symbols, "date": [day, yesterday.date(), day, day, day],
        "raw_close": [10., 10., 10., None, float("inf")], "close": [10.] * 5,
        "ma5": [5.] * 5, "ma10": [5.] * 5, "ma20": [5.] * 5,
        "quote_ts": [int(t.timestamp() * 1000) for t in [yesterday, now, future, now, now]],
    }), day)
    response = client.post("/api/custom/trading-plan/sync", json={"date": str(day), "symbols": symbols})
    assert response.status_code == 200
    for row in response.json()["rows"]:
        assert row["price"] is None
        assert row["ma5_price"] is None
        assert all(row[f"above_ma{n}"] is None for n in (5, 10, 20))
        assert row["issues"]


@pytest.mark.parametrize("close,ma5,raw,expected", [
    (10., 9.125, 10., 9.13),
    (5., 4.125, 10., 8.25),
    (None, 9., 10., None), (0., 9., 10., None),
    (10., None, 10., None), (10., float("inf"), 10., None),
    (10., float("nan"), 10., None), (10., -1., 10., None),
    (1e-300, 1e300, 10., None), (1e300, 1e-300, 10., None),
])
def test_sync_stop_price_rounding_and_invalid_ma_preserves_stop(client, sync_market, close, ma5, raw, expected):
    day, repo, _ = sync_market
    frame, _ = repo.get_enriched_latest.return_value
    repo.get_enriched_latest.return_value = (frame.filter(pl.col("symbol") == "600000.SH").with_columns(
        pl.lit(close).alias("close"), pl.lit(ma5).alias("ma5"), pl.lit(raw).alias("raw_close"),
    ), day)
    response = client.post("/api/custom/trading-plan/sync", json={"date": str(day), "symbols": ["600000.SH"]})
    assert response.status_code == 200
    row = response.json()["rows"][0]
    assert row["price"] == raw
    assert row["ma5_price"] == expected
    if expected is None:
        assert any("止损线" in issue for issue in row["issues"])


@pytest.mark.parametrize("failure", [False, RuntimeError("private provider details")])
def test_sync_failure_releases_demand_and_does_not_return_stale_success(client, sync_market, failure):
    day, repo, qs = sync_market
    if isinstance(failure, Exception):
        qs.refresh.side_effect = failure
    else:
        qs.refresh.return_value = {"updated": False}
    response = client.post("/api/custom/trading-plan/sync", json={"date": str(day), "symbols": ["600000.SH"]})
    assert response.status_code == 503
    assert "private provider details" not in response.text
    qs.unsubscribe_quotes.assert_called_once()
    repo.get_enriched_latest.assert_not_called()


def test_sync_only_accepts_today_and_available_unpaused_source(client, sync_market, monkeypatch):
    day, _, qs = sync_market
    request = {"date": "2026-11-18", "symbols": ["600000.SH"]}
    assert client.post("/api/custom/trading-plan/sync", json=request).status_code == 409
    request["date"] = str(day)
    monkeypatch.setattr(plans, "capability_gate", lambda _: (False, "不可用"))
    assert client.post("/api/custom/trading-plan/sync", json=request).status_code == 503
    monkeypatch.setattr(plans, "capability_gate", lambda _: (True, "可用"))
    qs.status.return_value = {"paused": True}
    assert client.post("/api/custom/trading-plan/sync", json=request).status_code == 503
    qs.subscribe_quotes.assert_not_called()
    qs.refresh.assert_not_called()


def test_sync_hundred_symbols_uses_two_temporary_demand_batches(client, sync_market):
    day, _, qs = sync_market
    response = client.post("/api/custom/trading-plan/sync", json={
        "date": str(day), "symbols": [f"{i:06}.SH" for i in range(100)],
    })
    assert response.status_code == 200
    assert [len(call.args[1]) for call in qs.subscribe_quotes.call_args_list] == [64, 36]
    assert qs.unsubscribe_quotes.call_count == 2
    qs.refresh.assert_called_once()


@pytest.mark.parametrize("symbols", [[], ["../../secret"], ["600000.SH"] * 101])
def test_sync_validates_symbols_before_fetching(client, sync_market, symbols):
    day, _, qs = sync_market
    assert client.post("/api/custom/trading-plan/sync", json={"date": str(day), "symbols": symbols}).status_code == 422
    qs.refresh.assert_not_called()
