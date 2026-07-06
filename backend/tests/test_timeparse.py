from app.timeparse import format_hms, parse_duration_ms


def test_mywer_full_format():
    assert parse_duration_ms("00:01:02.345678") == 62346
    assert parse_duration_ms("00:00:52.123000") == 52123


def test_zero_means_absent():
    assert parse_duration_ms("00:00:00.000000") is None
    assert parse_duration_ms("0") is None
    assert parse_duration_ms("") is None
    assert parse_duration_ms(None) is None


def test_apex_short_formats():
    assert parse_duration_ms("1:02.345") == 62345
    assert parse_duration_ms("52.345") == 52345
    assert parse_duration_ms("52,345") == 52345   # comma decimal
    assert parse_duration_ms("52") == 52000


def test_garbage():
    assert parse_duration_ms("abc") is None
    assert parse_duration_ms("1:2:3:4") is None


def test_format_hms():
    assert format_hms("00:12:34") == "12:34"
    assert format_hms("01:12:34") == "01:12:34"
    assert format_hms("") == ""
