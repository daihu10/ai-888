from types import SimpleNamespace

import polars as pl
import pytest

from app.services import instrument_sync


def test_failed_exchange_preserves_existing_rows(tmp_path, monkeypatch):
    path = tmp_path / "instruments" / "instruments.parquet"
    path.parent.mkdir()
    pl.DataFrame({"symbol": ["000001.SZ"], "name": ["old"]}).write_parquet(path)
    monkeypatch.setattr(instrument_sync, "_fetch_instruments_via_provider", lambda: None)

    def fetch(ex, **kwargs):
        if ex == "SZ":
            raise RuntimeError("unavailable")
        return [{"symbol": f"123456.{ex}", "name": ex}]

    monkeypatch.setattr(instrument_sync, "get_client", lambda: SimpleNamespace(
        exchanges=SimpleNamespace(get_instruments=fetch)))
    assert instrument_sync.sync_instruments(tmp_path) == 3
    assert set(pl.read_parquet(path)["symbol"]) == {"000001.SZ", "123456.SH", "123456.BJ"}


def test_failed_exchange_without_backup_does_not_replace_table(tmp_path, monkeypatch):
    path = tmp_path / "instruments" / "instruments.parquet"
    path.parent.mkdir()
    pl.DataFrame({"symbol": ["123456.SH"]}).write_parquet(path)
    before = path.read_bytes()
    monkeypatch.setattr(instrument_sync, "_fetch_instruments_via_provider", lambda: None)
    monkeypatch.setattr(instrument_sync, "get_client", lambda: SimpleNamespace(
        exchanges=SimpleNamespace(get_instruments=lambda ex, **kwargs: [] if ex == "SZ"
                                  else [{"symbol": f"123456.{ex}"}])))
    with pytest.raises(RuntimeError, match="未覆盖旧维表"):
        instrument_sync.sync_instruments(tmp_path)
    assert path.read_bytes() == before
