from datetime import date

from app.services.market_intraday import parse_trends


def test_trends_only_return_requested_date_and_valid_prices():
    data = {'trends': [
        '2026-11-13 09:31,0,3601.2,0',
        '2026-11-12 09:30,0,3500,0',
        '2026-11-13 09:30,0,3600,0',
        '2026-11-13 09:32,0,nan,0',
        'bad',
    ]}
    assert parse_trends(data, date(2026, 11, 13)) == [
        {'time': '09:30', 'price': 3600}, {'time': '09:31', 'price': 3601.2},
    ]
    assert parse_trends(data, date(2026, 11, 14)) == []
