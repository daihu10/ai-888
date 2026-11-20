"""Prune persisted market-history data before a configured date."""
from __future__ import annotations

import re
import shutil
from datetime import date
from pathlib import Path

import polars as pl

from app.services.fs_utils import atomic_write_parquet

_PARTITIONED_TABLES = (
    "kline_daily", "kline_daily_enriched", "kline_index_daily", "kline_index_enriched",
    "kline_etf_daily", "kline_etf_enriched", "kline_minute", "kline_etf_minute",
)
_DATED_FILES = {
    "adj_factor/all.parquet": "trade_date",
    "adj_factor_etf/all.parquet": "trade_date",
    "mainline_history/part.parquet": "date",
    "regime_history/part.parquet": "date",
}


def prune_market_history(data_dir: Path, start_date: date) -> dict[str, int]:
    """Keep only market-history rows dated on/after start_date.

    The caller must ensure no synchronization or live-refresh writer is active.
    """
    root = Path(data_dir).resolve()
    removed: dict[str, int] = {}
    for name in _PARTITIONED_TABLES:
        base = root / name
        count = 0
        if base.is_dir():
            for part in base.iterdir():
                match = re.fullmatch(r"date=(\d{4}-\d{2}-\d{2})", part.name)
                if not match or date.fromisoformat(match.group(1)) >= start_date:
                    continue
                if part.is_symlink() or part.resolve().parent != base:
                    raise ValueError(f"refusing to prune path outside {name}")
                shutil.rmtree(part)
                count += 1
        removed[name] = count

    for relative, date_column in _DATED_FILES.items():
        path = root / relative
        if not path.is_file():
            continue
        if path.resolve().parent.parent != root:
            raise ValueError(f"refusing to update path outside data directory: {relative}")
        frame = pl.read_parquet(path)
        if date_column not in frame.columns:
            raise ValueError(f"{relative} has no {date_column} column")
        before = frame.height
        dates = pl.col(date_column).cast(pl.Date, strict=False)
        frame = frame.filter(dates >= pl.lit(start_date))
        atomic_write_parquet(frame, path)
        removed[relative] = before - frame.height

    from app.services import daily_health

    removed["integrity_entries"] = daily_health.prune_before(root, start_date)
    (root / "user_data" / "integrity_report.json").unlink(missing_ok=True)
    (root / "user_data" / "enriched_coverage_cache.json").unlink(missing_ok=True)
    return removed
