from datetime import date, datetime

from app.jobs.daily_pipeline import _latest_completed_daily_date


def test_before_close_targets_latest_completed_session(tmp_path, monkeypatch):
    from app.services import data_integrity

    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: {
        date(2026, 11, 18), date(2026, 11, 19),
    })
    result = _latest_completed_daily_date(
        tmp_path, date(2026, 11, 19), datetime.fromisoformat("2026-11-19T09:22:00+08:00"),
    )
    assert result == date(2026, 11, 18)


def test_after_close_targets_today_only_when_trading_session(tmp_path, monkeypatch):
    from app.services import data_integrity

    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: {
        date(2026, 11, 18), date(2026, 11, 19),
    })
    today = date(2026, 11, 19)
    assert _latest_completed_daily_date(
        tmp_path, today, datetime.fromisoformat("2026-11-19T15:35:00+08:00"),
    ) == today


def test_holiday_after_close_uses_previous_trading_day(tmp_path, monkeypatch):
    from app.services import data_integrity

    monkeypatch.setattr(data_integrity, "_trading_calendar", lambda: {date(2026, 11, 18)})
    assert _latest_completed_daily_date(
        tmp_path, date(2026, 11, 19), datetime.fromisoformat("2026-11-19T15:35:00+08:00"),
    ) == date(2026, 11, 18)
