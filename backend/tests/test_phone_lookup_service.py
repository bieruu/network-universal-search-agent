"""Tests for the offline phone format validator.

Test vectors are real, well-known ranges verified against the metadata bundled
with libphonenumber 9.0.40 (Indonesian mobile +62 812, US landline +1 415). The
two deliberately-invalid vectors were chosen so they PARSE — the country code
resolves — but fail validation, because that is the only way to observe
`possible` and `valid` disagreeing. An unparseable string reports both False and
proves nothing.
"""

from __future__ import annotations

import ast
import json

import pytest

from app.services import phone_lookup_service as phone

VALID_ID_INTL = "+62 812 3456 7890"  # Indonesian mobile -> region ID
VALID_US_INTL = "+1 415 555 2671"  # US landline, San Francisco
VALID_NATIONAL_ID = "0812 3456 7890"  # same number, national form, needs region="ID"
# Parses with the right country code but is not a real Indonesian number.
POSSIBLE_NOT_VALID_ID = "+62 999 999 999 999"
# NANP-shaped and possible, but area code 000 does not exist.
POSSIBLE_NOT_VALID_US = "+1 000 000 0000"


# --- valid international -----------------------------------------------------


def test_valid_international_parses_region_and_e164():
    res = phone.lookup(VALID_ID_INTL)
    assert res["valid"] is True
    assert res["possible"] is True
    assert res["e164"] == "+6281234567890"
    assert res["region"] == "ID"
    assert res["country_code"] == 62
    assert res["country"] == "Indonesia"
    assert res["national_format"]
    assert res["international_format"]


def test_valid_number_formats_are_bounded():
    res = phone.lookup(VALID_US_INTL)
    assert res["valid"] is True
    assert res["e164"] == "+14155552671"
    assert res["region"] == "US"
    for key in ("e164", "national_format", "international_format"):
        assert 0 < len(res[key]) <= phone.MAX_FORMATTED_CHARS


# --- national format + region ------------------------------------------------


def test_national_format_resolves_when_region_supplied():
    res = phone.lookup(VALID_NATIONAL_ID, region="ID")
    assert res["valid"] is True
    assert res["e164"] == "+6281234567890"
    assert res["region"] == "ID"


def test_national_format_without_region_reports_false_and_never_raises():
    res = phone.lookup(VALID_NATIONAL_ID)
    assert res["valid"] is False
    assert res["possible"] is False
    assert res["country_code"] is None
    # The note has to tell the user how to fix it, not just that it failed.
    assert "region" in res["note"].lower()


def test_region_is_case_insensitive():
    assert phone.lookup(VALID_NATIONAL_ID, region="id")["valid"] is True


# --- possible vs valid are separate fields -----------------------------------


def test_possible_true_but_valid_false_reported_as_distinct_fields():
    res = phone.lookup(POSSIBLE_NOT_VALID_ID)
    assert res["possible"] is True
    assert res["valid"] is False
    # The country prefix still resolves even though the number is invalid, and
    # it is reported as a formatting fact, not a claim about the number.
    assert res["country_code"] == 62
    assert res["region"] == "ID"


def test_possible_true_valid_false_for_unassigned_area_code():
    res = phone.lookup(POSSIBLE_NOT_VALID_US)
    assert res["possible"] is True
    assert res["valid"] is False


def test_format_strings_are_withheld_when_invalid():
    res = phone.lookup(POSSIBLE_NOT_VALID_ID)
    assert res["valid"] is False
    # Handing back a copy-pasteable E.164 for a number this module just called
    # invalid is a footgun, so the fields stay empty instead.
    assert res["e164"] is None
    assert res["national_format"] is None
    assert res["international_format"] is None


# --- invalid / garbage -------------------------------------------------------


def test_invalid_number_returns_false_without_raising():
    res = phone.lookup(POSSIBLE_NOT_VALID_ID)
    assert res["valid"] is False
    assert res["source"] == phone.SOURCE


def test_unparseable_digits_return_false_dict_not_exception():
    res = phone.lookup("123")
    assert res["valid"] is False
    assert res["possible"] is False
    assert res["note"]


@pytest.mark.parametrize("garbage", ["", "   ", "abc", "n/a", "-", "not-a-number!"])
def test_input_with_no_digits_raises_value_error(garbage):
    # Stated contract: a str with no ASCII digits is "not even a plausible
    # phone string" -> ValueError, so the router can answer 422 instead of
    # dressing it up as a merely-invalid number.
    with pytest.raises(ValueError):
        phone.lookup(garbage)


@pytest.mark.parametrize("bad", [None, 123, b"+6281234567890", ["+6281234567890"], {}])
def test_non_string_number_raises_type_error(bad):
    with pytest.raises(TypeError):
        phone.lookup(bad)  # type: ignore[arg-type]


# --- truncation / sanitising -------------------------------------------------


def test_over_length_input_is_truncated_and_says_so():
    # Trailing padding would be stripped as whitespace, so the over-length input
    # has to be over-length in the digits themselves.
    res = phone.lookup("+62 999 999 999 999 " * 5)
    assert len(res["input"]) == phone.MAX_INPUT_CHARS
    assert "truncated" in res["note"].lower()


def test_control_characters_are_stripped_not_echoed():
    res = phone.lookup("\x00\x07+62 812\x1b[31m 3456 7890")
    assert res["input"] == "+62 812 3456 7890"
    assert "\x1b" not in res["input"]
    assert res["valid"] is True
    assert res["e164"] == "+6281234567890"


def test_every_string_field_is_bounded():
    res = phone.lookup("+62 999 999 999 999 " * 8)
    assert len(res["input"]) <= phone.MAX_INPUT_CHARS
    assert len(res["note"]) <= phone.MAX_NOTE_CHARS
    for key in ("area_description", "country"):
        assert res[key] is None or len(res[key]) <= phone.MAX_GEO_CHARS


def test_result_is_json_serialisable():
    assert json.loads(json.dumps(phone.lookup(VALID_ID_INTL)))["valid"] is True
    assert json.loads(json.dumps(phone.lookup(POSSIBLE_NOT_VALID_ID)))["valid"] is False
    assert json.loads(json.dumps(phone.lookup("123")))["valid"] is False


# --- formatting guard --------------------------------------------------------


def test_format_number_failure_is_contained(monkeypatch):
    # phonenumbers.format_number can raise on inputs the parse stage accepted;
    # the field must degrade to None instead of turning the request into a 500.
    npe = phone.phonenumbers.NumberParseException

    def boom(_number, _fmt):
        raise npe(npe.NOT_A_NUMBER, "formatting failed")

    monkeypatch.setattr(phone.phonenumbers, "format_number", boom)
    res = phone.lookup(VALID_ID_INTL)
    assert res["valid"] is True
    assert res["e164"] is None
    assert res["national_format"] is None
    assert res["international_format"] is None
    # Everything not produced by format_number survives the failure.
    assert res["region"] == "ID"
    assert res["country_code"] == 62
    assert res["note"]


# --- region argument ---------------------------------------------------------


@pytest.mark.parametrize("bad_region", ["USA", "U1", "1", "", "  ", "u s", "GB-"])
def test_bad_region_raises_value_error(bad_region):
    with pytest.raises(ValueError):
        phone.lookup(VALID_ID_INTL, region=bad_region)


def test_unknown_but_well_formed_region_raises_value_error():
    # "ZZ" passes the two-letter shape check but is not a real region. Silently
    # ignoring it would parse against the wrong country and report a confident
    # verdict for the wrong place.
    with pytest.raises(ValueError):
        phone.lookup(VALID_NATIONAL_ID, region="ZZ")


def test_non_geographical_calling_code_is_not_accepted_as_region():
    with pytest.raises(ValueError):
        phone.lookup(VALID_NATIONAL_ID, region="001")


def test_non_string_region_raises_type_error():
    with pytest.raises(TypeError):
        phone.lookup(VALID_ID_INTL, region=5)  # type: ignore[arg-type]


# --- bulk --------------------------------------------------------------------


def test_lookup_many_uses_lookup_for_each_item():
    res = phone.lookup_many([VALID_ID_INTL, VALID_NATIONAL_ID], region="ID")
    assert res["count"] == 2
    assert res["submitted"] == 2
    assert res["counts_truncated"] is False
    assert res["valid_count"] == 2
    assert [r["e164"] for r in res["results"]] == ["+6281234567890"] * 2
    assert all(r["source"] == phone.SOURCE for r in res["results"])


def test_lookup_many_enforces_hard_cap_and_flags_truncation():
    res = phone.lookup_many([VALID_US_INTL] * 150)
    assert phone.MAX_BULK == 100
    assert res["count"] == 100
    assert res["submitted"] == 150
    assert res["counts_truncated"] is True
    assert len(res["results"]) == 100


def test_lookup_many_at_cap_is_not_flagged():
    res = phone.lookup_many([VALID_US_INTL] * phone.MAX_BULK)
    assert res["count"] == phone.MAX_BULK
    assert res["counts_truncated"] is False


def test_lookup_many_isolates_a_bad_item_instead_of_failing_the_batch():
    res = phone.lookup_many([VALID_ID_INTL, "abc", POSSIBLE_NOT_VALID_US, 123])
    assert res["count"] == 4
    assert res["valid_count"] == 1
    rejected = res["results"][1]
    assert rejected["valid"] is False
    assert "rejected before parsing" in rejected["note"].lower()
    non_string = res["results"][3]
    assert non_string["valid"] is False
    assert non_string["possible"] is False


def test_lookup_many_empty_list_is_not_an_error():
    res = phone.lookup_many([])
    assert res["count"] == 0
    assert res["results"] == []
    assert res["counts_truncated"] is False


def test_lookup_many_rejects_a_bare_string():
    with pytest.raises(TypeError):
        phone.lookup_many(VALID_ID_INTL)  # type: ignore[arg-type]


def test_lookup_many_validates_region_even_with_no_numbers():
    with pytest.raises(ValueError):
        phone.lookup_many([], region="ZZ")


def test_lookup_many_result_is_json_serialisable():
    res = json.loads(json.dumps(phone.lookup_many([VALID_ID_INTL, "abc", "123"])))
    assert res["count"] == 3
    assert res["valid_count"] == 1


# --- honesty about what is NOT known ----------------------------------------


def test_valid_note_disclaims_existence_and_carrier_lookup():
    note = phone.lookup(VALID_ID_INTL)["note"].lower()
    assert "does not confirm" in note
    assert "exists" in note and "in use" in note
    assert "named person" in note
    assert "carrier and line-type lookup are not included" in note


@pytest.mark.parametrize("raw", [POSSIBLE_NOT_VALID_ID, POSSIBLE_NOT_VALID_US, "123"])
def test_invalid_note_disclaims_carrier_lookup_too(raw):
    note = phone.lookup(raw)["note"].lower()
    assert "carrier and line-type lookup are not included" in note


def test_source_is_labelled_offline():
    assert "offline" in phone.SOURCE.lower()
    assert phone.lookup(VALID_ID_INTL)["source"] == phone.SOURCE
    assert phone.lookup_many([])["source"] == phone.SOURCE


def test_module_imports_no_network_or_carrier_client():
    # Guards against a future edit quietly wiring up the paid lookup this
    # module deliberately omits: only local library imports are allowed.
    tree = ast.parse(inspect_source())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert imported == {"__future__", "re", "typing", "phonenumbers"}


def inspect_source() -> str:
    import inspect

    return inspect.getsource(phone)
