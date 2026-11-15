from types import SimpleNamespace
from datetime import date

import polars as pl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import screener
from app.services import market_overview_builder as builder


def test_dimension_rank_includes_limit_up_and_down_counts(monkeypatch, tmp_path):
    config = SimpleNamespace(id="test", symbol_map={}, code_map={})
    store = SimpleNamespace(data_dir=tmp_path, load_all=lambda: [config])
    repo = SimpleNamespace(store=store)
    monkeypatch.setattr(builder, "ExtConfigStore", lambda _: store)
    monkeypatch.setattr(builder, "_dimension_field", lambda *_: "concept")
    monkeypatch.setattr(builder, "_read_ext_rows", lambda *_: [
        {"symbol": "000001.SZ", "concept": "AI"},
        {"symbol": "000002.SZ", "concept": "AI"},
        {"symbol": "000003.SZ", "concept": "AI"},
    ])

    result = builder._dimension_rank([
        {"symbol": "000001.SZ", "change_pct": 0.1, "signal_limit_up": True, "consecutive_limit_ups": 1},
        {"symbol": "000002.SZ", "change_pct": 0.02, "signal_limit_up": False, "consecutive_limit_ups": 0, "signal_limit_down": True},
        {"symbol": "000003.SZ", "change_pct": -0.1, "signal_limit_up": False, "consecutive_limit_ups": 0, "signal_limit_down": False},
    ], repo, "concept")

    assert result["leading"][0]["limit_up_count"] == 1
    assert result["leading"][0]["limit_down_count"] == 1


def test_market_snapshot_exposes_fuyao_limit_signals(monkeypatch):
    class FakeScreenerService:
        def __init__(self, repo):
            pass

        def latest_date(self):
            return date(2026, 11, 13)

        def _load_enriched_for_date(self, as_of):
            return pl.DataFrame({
                "symbol": ["000001.SZ"],
                "signal_limit_up": [True],
                "signal_limit_down": [False],
            })

    monkeypatch.setattr(screener, "ScreenerService", FakeScreenerService)
    app = FastAPI()
    app.include_router(screener.router)
    app.state.repo = object()

    response = TestClient(app).get("/api/screener/market-snapshot")

    assert response.status_code == 200
    assert response.json()["rows"][0]["signal_limit_up"] is True
    assert response.json()["rows"][0]["signal_limit_down"] is False
