from app.services import risk


def test_empty_is_zero():
    s, _ = risk.score({})
    assert s == 0


def test_many_ports_and_vulns_cap():
    results = {
        "shodan": {"ports": list(range(8)), "vulns": ["CVE-1 critical", "CVE-2"]},
        "crtsh": {"count": 30},
    }
    s, b = risk.score(results)
    assert 0 < s <= 100
    assert b["open_ports"] == 1.0
