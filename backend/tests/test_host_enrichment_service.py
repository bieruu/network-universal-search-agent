"""Host enrichment is a pure, passive derivation over an existing Shodan payload.

Nothing here is stubbed because nothing needs stubbing: `enrich()` has no HTTP
client, no socket, no resolver and no clock, so a test is a dict in and a dict
out. That is also the claim the last test in this file enforces by AST-parsing
the module — see `test_module_imports_nothing_networking_related`.
"""

from __future__ import annotations

import ast
import inspect

import pytest

from app.services import host_enrichment_service as host

# A realistic Shodan host response: the SHODAN_HOST shape already used by
# tests/test_single_resolve.py, extended with the fields shodan_service drops.
SHODAN_HOST = {
    "ip_str": "93.184.216.34",
    "asn": "AS13335 Cloudflare, Inc.",
    "isp": "Cloudflare, Inc.",
    "org": "Cloudflare, Inc.",
    "city": "Jakarta",
    "region_code": "JK",
    "country_name": "Indonesia",
    "country_code": "ID",
    "postal_code": "10110",
    "latitude": -6.1751,
    "longitude": 106.865,
    "timezone": "Asia/Jakarta",
    "network": "Cloudflare, Inc.",
    "domain": "example.com",
    "os": "Linux",
    "hostnames": ["example.com", "www.example.com"],
    "ports": [80, 443],
    "data": [
        {
            "port": 80,
            "transport": "tcp",
            "product": "nginx",
            "version": "1.25",
            "data": "server: nginx",
            "hostname": "www.example.com",
        },
        {
            "port": 53,
            "transport": "udp",
            "product": None,
            "version": None,
            "data": "",
        },
    ],
}

# The shape shodan_service.lookup() actually hands to the orchestrator: `data`
# renamed to `services`, the banner under `banner`, and "" for every field
# Shodan left out rather than None.
NORMALISED_HOST = {
    "source": "Shodan",
    "ip": "93.184.216.34",
    "ports": [80, 443],
    "services": [
        {
            "port": 80,
            "transport": "tcp",
            "product": "nginx",
            "version": "1.25",
            "banner": "server: nginx",
            "cpes": ["cpe:2.3:a:igor_sysoev:nginx:1.25:*:*:*:*:*:*:*"],
        }
    ],
    "vulns": [],
    "cpes": ["cpe:2.3:a:igor_sysoev:nginx:1.25:*:*:*:*:*:*:*"],
    "isp": "Example ISP",
    "asn": "AS1234",
    "city": "Jakarta",
    "country": "Indonesia",
}

ALL_NONE = {
    "source": host.SOURCE,
    "ip": None,
    "asn": None,
    "asn_org": None,
    "isp": None,
    "org": None,
    "city": None,
    "region": None,
    "country": None,
    "country_code": None,
    "postal_code": None,
    "latitude": None,
    "longitude": None,
    "timezone": None,
    "network": None,
    "domain": None,
    "os": None,
    "hostnames": [],
    "open_ports": [],
    "port_count": 0,
    "ports_truncated": False,
}


# --- a full realistic payload ----------------------------------------------


def test_full_payload_populates_every_field():
    out = host.enrich(SHODAN_HOST)

    assert out["ip"] == "93.184.216.34"
    assert out["asn"] == "AS13335"
    assert out["asn_org"] == "Cloudflare, Inc."
    assert out["isp"] == "Cloudflare, Inc."
    assert out["org"] == "Cloudflare, Inc."
    assert out["city"] == "Jakarta"
    assert out["region"] == "JK"
    assert out["country"] == "Indonesia"
    assert out["country_code"] == "ID"
    assert out["postal_code"] == "10110"
    assert out["latitude"] == pytest.approx(-6.1751)
    assert out["longitude"] == pytest.approx(106.865)
    assert out["timezone"] == "Asia/Jakarta"
    assert out["network"] == "Cloudflare, Inc."
    assert out["domain"] == "example.com"
    assert out["os"] == "Linux"
    assert out["hostnames"] == ["example.com", "www.example.com"]
    assert out["port_count"] == 3
    assert out["ports_truncated"] is False


def test_source_labels_itself_passive():
    assert host.enrich(SHODAN_HOST)["source"] == host.SOURCE
    assert "passive" in host.SOURCE.lower()


def test_asn_is_split_into_number_and_org():
    # Shodan ships both in one string; the UI needs the number on its own.
    out = host.enrich({"asn": "AS13335 Cloudflare, Inc."})

    assert (out["asn"], out["asn_org"]) == ("AS13335", "Cloudflare, Inc.")


def test_a_bare_asn_yields_no_org_rather_than_an_empty_one():
    out = host.enrich({"asn": "AS1234"})

    assert out["asn"] == "AS1234"
    assert out["asn_org"] is None
    assert out["org"] is None


def test_unrecognised_asn_is_kept_whole_not_guessed_at():
    out = host.enrich({"asn": "Example Network"})

    assert out["asn"] == "Example Network"
    assert out["asn_org"] is None


def test_org_falls_back_to_the_asn_org_when_normalisation_dropped_org():
    # The normalised dict has no `org` key at all; the ASN's registered name is
    # the honest stand-in, not a blank.
    out = host.enrich({"asn": "AS13335 Cloudflare, Inc."})

    assert out["org"] == "Cloudflare, Inc."


def test_explicit_org_wins_over_the_asn_fallback():
    out = host.enrich({"asn": "AS13335 Cloudflare, Inc.", "org": "Example Hosting"})

    assert out["org"] == "Example Hosting"
    assert out["asn_org"] == "Cloudflare, Inc."


# --- the normalised dict shodan_service actually returns --------------------


def test_reads_the_normalised_service_shape():
    out = host.enrich(NORMALISED_HOST)

    assert out["ip"] == "93.184.216.34"
    assert out["asn"] == "AS1234"
    assert out["isp"] == "Example ISP"
    # Normalisation renames country_name -> country; both names are read.
    assert out["country"] == "Indonesia"
    assert out["city"] == "Jakarta"
    # 443 is named in `ports` only, so it keeps a tcp default and no product.
    by_port = {entry["port"]: entry for entry in out["open_ports"]}
    assert by_port[443] == {
        "port": 443,
        "transport": "tcp",
        "product": None,
        "version": None,
        "banner": None,
    }


def test_a_banner_under_the_normalised_name_is_read():
    out = host.enrich(NORMALISED_HOST)

    assert out["open_ports"][0]["banner"] == "server: nginx"
    assert out["open_ports"][0]["product"] == "nginx"
    assert out["open_ports"][0]["version"] == "1.25"


def test_normalisation_empty_strings_read_as_absent_not_as_data():
    # shodan_service emits "" for every field Shodan left out. A blank city is
    # not a city, so it must not reach the UI as one.
    out = host.enrich({**NORMALISED_HOST, "city": "", "isp": "", "asn": ""})

    assert out["city"] is None
    assert out["isp"] is None
    assert out["asn"] is None


# --- missing payloads never raise and never invent -------------------------


@pytest.mark.parametrize("payload", [None, {}, "nope", 42, [], ["1.2.3.4"]])
def test_missing_or_non_dict_payloads_return_the_all_none_shape(payload):
    out = host.enrich(payload)

    assert {k: v for k, v in out.items() if k != "note"} == ALL_NONE
    assert isinstance(out["note"], str) and out["note"]


def test_absent_fields_are_none_not_zero_or_empty_string():
    # A missing city must never be able to render as "unknown, 0,0".
    out = host.enrich(None)

    assert out["city"] is None
    assert out["latitude"] is None
    assert out["longitude"] is None
    assert out["port_count"] == 0
    assert out["hostnames"] == []
    assert out["open_ports"] == []


def test_the_note_names_what_shodan_did_not_return():
    note = host.enrich(None)["note"]

    assert "Not returned by Shodan:" in note
    for field in ("asn", "city", "latitude", "os"):
        assert field in note


# --- passivity is stated on every result -----------------------------------


def test_every_note_states_that_nothing_was_probed():
    for payload in (None, {}, SHODAN_HOST, NORMALISED_HOST, {"ports": []}):
        note = host.enrich(payload)["note"]
        assert "passive records" in note
        assert "never probes a target" in note


def test_the_passive_sentence_survives_the_note_length_bound():
    # The passivity promise is the first clause, so a long list of absent
    # fields can never push it out of the bounded note.
    note = host.enrich({"os": "x", "domain": "y", "hostnames": ["h.example.com"]})[
        "note"
    ]

    assert note.startswith(host.PASSIVE_NOTE)
    assert len(note) <= host.MAX_NOTE_CHARS


def test_an_empty_port_list_is_absence_of_data_not_closed_ports():
    note = host.enrich({"city": "Jakarta"})["note"]

    assert "absence of data" in note
    assert "not evidence that every port is closed" in note


def test_note_clauses_are_prose_not_semicolon_soup():
    # Clauses are joined with a space, so a full note never reads "... §7).; Shodan ...".
    note = host.enrich({"ports": list(range(1, 601))})["note"]

    assert ").;" not in note
    assert ";;" not in note


# --- wrongly-typed fields are untrusted, not coerced ------------------------


def test_wrongly_typed_fields_never_raise_and_never_become_strings():
    out = host.enrich(
        {
            "ip": 12345,
            "asn": ["AS1"],
            "isp": {"name": "nope"},
            "city": 123,
            "country": True,
            "country_code": 7.5,
            "postal_code": ["10110"],
            "timezone": 99,
            "os": None,
            "domain": 42,
        }
    )

    assert out["ip"] is None
    assert out["asn"] is None
    assert out["isp"] is None
    assert out["city"] is None  # not "123"
    assert out["country"] is None
    assert out["country_code"] is None
    assert out["postal_code"] is None
    assert out["timezone"] is None
    assert out["os"] is None
    assert out["domain"] is None


@pytest.mark.parametrize("bad_ports", ["nope", 80, {"80": True}, 3.5, object()])
def test_ports_of_the_wrong_type_yield_an_empty_list(bad_ports):
    out = host.enrich({"ports": bad_ports})

    assert out["open_ports"] == []
    assert out["port_count"] == 0
    assert out["ports_truncated"] is False


def test_a_string_data_field_does_not_crash_the_service_rows_walk():
    # Shodan uses `data` as a banner string on some endpoints.
    out = host.enrich({"ports": [80], "data": "not a list of services"})

    assert out["port_count"] == 1


def test_hostnames_of_the_wrong_type_are_skipped():
    out = host.enrich({"hostnames": "example.com", "ports": []})

    assert out["hostnames"] == []


# --- coordinates ------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        (-6.1751, -6.1751),
        (0, 0.0),
        (-90, -90.0),
        (90, 90.0),
        ("-6.1751", -6.1751),
        ("89.9", 89.9),
    ],
)
def test_coordinates_are_floats_or_none(value, expected):
    out = host.enrich({"latitude": value})

    assert out["latitude"] == pytest.approx(expected)
    assert isinstance(out["latitude"], float)


@pytest.mark.parametrize(
    "value", [91, -91, 1000, float("nan"), float("inf"), True, False, None, "abc", {}]
)
def test_out_of_range_nan_and_non_numeric_coordinates_are_absent(value):
    assert host.enrich({"latitude": value})["latitude"] is None


@pytest.mark.parametrize("value", [181, -181, float("nan"), float("-inf"), True, "x"])
def test_longitudes_are_range_checked_too(value):
    assert host.enrich({"longitude": value})["longitude"] is None


def test_coordinates_are_never_string_coerced_into_the_output():
    out = host.enrich({"latitude": "-6.1751", "longitude": "106.865"})

    assert isinstance(out["latitude"], float)
    assert isinstance(out["longitude"], float)


# --- ports: passive, deduped, sorted, capped --------------------------------


def test_out_of_range_and_non_integer_ports_are_skipped():
    out = host.enrich(
        {"ports": [80, 0, -1, 65536, 99999, "443", 80.5, True, None, [22], {"p": 1}]}
    )

    assert [entry["port"] for entry in out["open_ports"]] == [80]


def test_a_port_is_only_deduped_by_port_and_transport():
    out = host.enrich(
        {
            "data": [
                {"port": 53, "transport": "tcp", "product": "tcp-dns"},
                {"port": 53, "transport": "udp", "product": "dnsmasq"},
            ]
        }
    )

    assert [(e["port"], e["transport"]) for e in out["open_ports"]] == [
        (53, "tcp"),
        (53, "udp"),
    ]
    assert out["port_count"] == 2


def test_a_duplicate_port_keeps_the_detail_from_either_occurrence():
    # 80 appears in the bare list first, which carries no detail at all.
    out = host.enrich(
        {
            "ports": [80],
            "data": [{"port": 80, "product": "nginx", "version": "1.25", "data": "hi"}],
        }
    )

    assert out["open_ports"] == [
        {
            "port": 80,
            "transport": "tcp",
            "product": "nginx",
            "version": "1.25",
            "banner": "hi",
        }
    ]
    assert out["port_count"] == 1


def test_ports_sort_numerically_not_lexically():
    out = host.enrich({"ports": [443, 80, 8080, 21]})

    assert [entry["port"] for entry in out["open_ports"]] == [21, 80, 443, 8080]


def test_transport_defaults_to_tcp_and_is_lowercased():
    out = host.enrich({"data": [{"port": 22}, {"port": 23, "transport": "TCP"}]})

    assert [(e["port"], e["transport"]) for e in out["open_ports"]] == [
        (22, "tcp"),
        (23, "tcp"),
    ]


def test_a_service_entry_with_an_unusable_port_is_skipped():
    out = host.enrich({"data": [{"port": "80"}, {"port": 443}]})

    assert [entry["port"] for entry in out["open_ports"]] == [443]


def test_ports_are_capped_at_500_and_say_so():
    out = host.enrich({"ports": list(range(1, 601))})

    assert out["port_count"] == 500
    assert len(out["open_ports"]) == 500
    assert out["ports_truncated"] is True
    # The lowest 500 are kept, deterministically.
    assert out["open_ports"][0]["port"] == 1
    assert out["open_ports"][-1]["port"] == 500
    assert "100 further passive port entries were omitted (cap 500)" in out["note"]


def test_exactly_the_cap_is_not_reported_as_truncated():
    out = host.enrich({"ports": list(range(1, 501))})

    assert out["port_count"] == 500
    assert out["ports_truncated"] is False


def test_port_count_always_matches_the_rows_returned():
    for payload in ({"ports": [80, 443]}, {"ports": list(range(1, 900))}, {}):
        out = host.enrich(payload)
        assert out["port_count"] == len(out["open_ports"])


def test_an_endless_duplicate_port_payload_is_bounded_not_walked_forever():
    # A hostile payload repeating one port must not become a denial of service.
    out = host.enrich({"ports": [80] * 200_000})

    assert out["port_count"] == 1
    assert len(out["open_ports"]) == 1


# --- untrusted strings are bounded -----------------------------------------


def test_long_strings_are_truncated_to_200_characters():
    out = host.enrich(
        {
            "isp": "I" * 5000,
            "org": "O" * 5000,
            "city": "C" * 5000,
            "country": "N" * 5000,
            "network": "W" * 5000,
            "domain": "D" * 5000,
            "os": "S" * 5000,
        }
    )

    for field in ("isp", "org", "city", "country", "network", "domain", "os"):
        assert len(out[field]) == host.MAX_VALUE_CHARS == 200


def test_an_attacker_controlled_banner_is_truncated_to_2kb():
    # The per-port `data`/banner is bytes the target itself sent.
    out = host.enrich({"data": [{"port": 80, "data": "A" * 5000}]})

    assert len(out["open_ports"][0]["banner"]) == host.MAX_BANNER_CHARS == 2048


def test_a_normalised_banner_is_truncated_to_2kb_too():
    out = host.enrich({"services": [{"port": 80, "banner": "B" * 5000}]})

    assert len(out["open_ports"][0]["banner"]) == 2048


def test_product_and_version_keep_the_shodan_service_bounds():
    out = host.enrich(
        {"data": [{"port": 80, "product": "p" * 5000, "version": "v" * 5000}]}
    )

    assert len(out["open_ports"][0]["product"]) == 200
    assert len(out["open_ports"][0]["version"]) == 100


def test_hostnames_are_capped_at_100_and_each_capped_at_253():
    out = host.enrich(
        {"hostnames": [f"host-{i}.example.com" for i in range(150)] + ["h" * 500]}
    )

    assert len(out["hostnames"]) == 100
    assert out["hostnames"][0] == "host-0.example.com"
    assert max(len(name) for name in out["hostnames"]) <= 253
    assert "Hostname list capped at 100." in out["note"]


def test_exactly_100_hostnames_is_not_reported_as_capped():
    out = host.enrich({"hostnames": [f"host-{i}.example.com" for i in range(100)]})

    assert len(out["hostnames"]) == 100
    assert "Hostname list capped at 100." not in out["note"]


def test_hostnames_are_deduped_case_insensitively_and_across_sources():
    out = host.enrich(
        {
            "hostnames": ["example.com", "EXAMPLE.com.", "example.com"],
            "domains": ["example.com", "cdn.example.com"],
            "data": [{"port": 80, "hostname": "WWW.example.com"}],
        }
    )

    assert out["hostnames"] == ["example.com", "cdn.example.com", "WWW.example.com"]


def test_non_string_hostname_entries_are_skipped():
    out = host.enrich({"hostnames": ["example.com", 42, None, {"h": 1}]})

    assert out["hostnames"] == ["example.com"]


# --- purity -----------------------------------------------------------------


def test_enrich_is_pure_and_deterministic():
    # Same input, same output, and the input is never mutated — a derivation
    # over someone else's dict, not a consumer of it.
    payload = dict(SHODAN_HOST)
    before = dict(payload)

    first = host.enrich(payload)
    second = host.enrich(payload)

    assert first == second
    assert payload == before


def test_enrich_never_raises_on_nested_hostile_values():
    payload = {
        "ports": [{"port": [1]}, {"port": {"a": 1}}],
        "services": ["string", None, 42, {"port": 80}],
        "data": {"not": "a list"},
        "hostnames": {"not": "a list"},
        "latitude": object(),
        "asn": b"AS1 bytes",
    }

    out = host.enrich(payload)

    assert out["port_count"] == 1
    assert out["latitude"] is None
    assert out["asn"] is None


# --- the passive-only promise ----------------------------------------------


BANNED_IMPORTS = {
    "asyncio",
    "aiohttp",
    "ftplib",
    "http",
    "httpx",
    "httplib2",
    "requests",
    "smtplib",
    "socket",
    "socketserver",
    "ssl",
    "subprocess",
    "telnetlib",
    "urllib",
    "urllib3",
}


def _imported_roots(module_source: str) -> set[str]:
    imported: set[str] = set()
    for node in ast.walk(ast.parse(module_source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    return imported


def test_module_imports_nothing_networking_related():
    # This is the test that makes the "passive only" promise enforceable rather
    # than aspirational: every way this module could touch a target — an HTTP
    # client, a raw socket, an async loop, a spawned `nmap` — arrives as an
    # import. None of them is here, so this module cannot become an active
    # scanner without failing the suite.
    imported = _imported_roots(inspect.getsource(host))

    assert imported & BANNED_IMPORTS == set(), f"networking import crept in: {imported}"
    # Belt and braces: nothing beyond typing is imported at all, so a new
    # dependency cannot be smuggled in under a name this list forgot.
    assert imported == {"__future__", "typing"}


def _code_identifiers_and_strings(module) -> set[str]:
    """Every identifier and non-docstring string literal in a module's code.

    Docstrings are subtracted so the module can *document* the scanners and
    second-party sources it refuses to use — naming `nmap` in a comment is the
    explanation, not the call. What is left is code: a call, an attribute or a
    literal that would actually reach the network.
    """
    tree = ast.parse(inspect.getsource(module))
    docstrings = {
        text
        for node in ast.walk(tree)
        if isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        )
        and (text := ast.get_docstring(node, clean=False))
    }
    collected: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            collected.add(node.value)
        elif isinstance(node, ast.Name):
            collected.add(node.id)
        elif isinstance(node, ast.Attribute):
            collected.add(node.attr)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            collected.add(node.name)
    return collected - docstrings


def test_module_code_names_no_scanner_and_no_second_paid_source():
    # AGENTS.md §7 excludes active scanning from v1, and the v2 TODO rules out
    # a second paid key for fields Shodan already returns. Scanned over the code
    # rather than the prose, so the module can still say out loud what it will
    # never do.
    code = " ".join(_code_identifiers_and_strings(host)).lower()

    for banned in (
        "nmap",
        "censys",
        "maxmind",
        "ipinfo",
        "ip-api",
        "ipapi",
        "traceroute",
        "ptr_record",
        "whois",
    ):
        assert banned not in code, f"{banned} reached the code of a passive module"


def test_enrich_takes_exactly_one_positional_payload():
    import inspect as _inspect

    signature = _inspect.signature(host.enrich)

    assert list(signature.parameters) == ["shodan_payload"]
    assert not _inspect.iscoroutinefunction(host.enrich)
