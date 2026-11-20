from datetime import date

import polars as pl

from app.services.data_retention import prune_market_history


def _part(root, table, day):
    path = root / table / f"date={day}"
    path.mkdir(parents=True)
    pl.DataFrame({"symbol": ["x"], "date": [date.fromisoformat(day)]}).write_parquet(
        path / "part.parquet"
    )


def test_prune_market_history_keeps_cutoff_and_newer_data(tmp_path):
    _part(tmp_path, "kline_daily", "2025-12-31")
    _part(tmp_path, "kline_daily", "2026-01-01")
    _part(tmp_path, "kline_index_daily", "2025-12-31")
    factor_dir = tmp_path / "adj_factor"
    factor_dir.mkdir()
    pl.DataFrame({
        "symbol": ["old", "new"],
        "trade_date": [date(2025, 12, 31), date(2026, 1, 1)],
        "ex_factor": [1.0, 1.0],
    }).write_parquet(factor_dir / "all.parquet")

    removed = prune_market_history(tmp_path, date(2026, 1, 1))

    assert removed["kline_daily"] == 1
    assert removed["kline_index_daily"] == 1
    assert not (tmp_path / "kline_daily/date=2025-12-31").exists()
    assert (tmp_path / "kline_daily/date=2026-01-01").exists()
    assert pl.read_parquet(factor_dir / "all.parquet")["symbol"].to_list() == ["new"]
