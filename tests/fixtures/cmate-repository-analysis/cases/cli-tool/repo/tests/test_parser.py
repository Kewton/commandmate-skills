from logsift.parser import parse_line


def test_parses_a_well_formed_line():
    line = '10.0.0.1 - - [01/Jan/2026:00:00:00 +0900] "GET /health HTTP/1.1" 200 12'
    record = parse_line(line)
    assert record is not None
    assert record.path == "/health"
    assert record.status == 200


def test_returns_none_for_garbage():
    assert parse_line("not a log line") is None
