"""Tests for exif_service.

Every fixture here is REAL image bytes built with Pillow itself — a genuine
JPEG carrying a genuine serialised EXIF block — so the module is exercised
against a real parser's output rather than a hand-rolled dict that only proves
the test agrees with itself. The bomb and truncated cases are hand-built
container headers, which is also the honest thing: those are real headers
describing pixels that do not exist.

Nothing here reads a file, opens a socket or shells out.
"""

from __future__ import annotations

import ast
import io
import struct
import zlib
from pathlib import Path

import pytest
from PIL import ExifTags, Image

from app.services import exif_service
from app.services.exif_service import extract, strip_for_store

SERVICE_PATH = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "exif_service.py"
)

SERIAL = "042051000437"
# EXIF stores a GPS coordinate as THREE rationals (degrees, minutes, seconds)
# and Pillow round-trips them as a flat num/den sequence, so that is what a
# spec-conformant fixture has to hand it.
LAT_DMS = [51, 1, 30, 1, 0, 1]  # 51 deg 30' 00" N
LON_DMS = [0, 1, 7, 1, 0, 1]  # 0 deg 07' 00" E


# --------------------------------------------------------------------------
# fixture builders
# --------------------------------------------------------------------------
def build_exif(
    *,
    with_gps: bool = True,
    with_serial: bool = True,
    artist_chars: int = 24,
    extra_ifd0: dict[int, str] | None = None,
) -> Image.Exif:
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "Canon"
    exif[ExifTags.Base.Model] = "Canon EOS 5D Mark IV"
    exif[ExifTags.Base.Software] = "OSINT fixture"
    exif[ExifTags.Base.Artist] = "a" * artist_chars
    for tag_id, text in (extra_ifd0 or {}).items():
        exif[tag_id] = text
    sub = exif.get_ifd(ExifTags.IFD.Exif)
    sub[ExifTags.Base.DateTimeOriginal] = "2024:05:01 12:33:44"
    sub[ExifTags.Base.LensModel] = "EF24-70mm f/2.8L II USM"
    if with_serial:
        # 0xA431 = EXIF 2.3 BodySerialNumber, the de-facto standard serial tag.
        sub[0xA431] = SERIAL
    if with_gps:
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
        gps[1] = "N"
        gps[2] = LAT_DMS
        gps[3] = "E"
        gps[4] = LON_DMS
        gps[5] = 0
        gps[6] = 45.5
        gps[7] = (12.0, 30.0)
        gps[8] = "9"
        gps[29] = "2024:05:01"
    return exif


def encode(
    image_format: str = "JPEG",
    *,
    size: tuple[int, int] = (4, 3),
    exif: Image.Exif | None = None,
) -> bytes:
    """Real bytes in `image_format`, written by Pillow's own encoder.

    Pillow 12's JPEG writer calls `len(exif)` on whatever it is handed, so a
    plain save has to omit the kwarg rather than pass `exif=None`.
    """
    buf = io.BytesIO()
    image = Image.new("RGB", size, (200, 30, 30))
    if exif is None:
        image.save(buf, format=image_format)
    else:
        image.save(buf, format=image_format, exif=exif)
    return buf.getvalue()


def jpeg_with_exif(**kwargs) -> bytes:
    return encode("JPEG", exif=build_exif(**kwargs))


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def png_claiming(width: int, height: int) -> bytes:
    """A structurally valid PNG header describing `width` x `height`.

    Real signature, real CRC-checked IHDR — Pillow accepts it as an image and
    reports the claimed size. That is precisely what makes it a bomb: a few
    hundred bytes of input, gigabytes of decode.
    """
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(b"\x00" * 8))
        + png_chunk(b"IEND", b"")
    )


# --------------------------------------------------------------------------
# 1. content-based sniffing
# --------------------------------------------------------------------------
def test_extracts_tags_from_a_real_jpeg_with_exif():
    result = extract(jpeg_with_exif(), filename="evidence.jpg")

    assert result["ok"] is True
    assert result["rejected_reason"] is None
    assert result["source"] == exif_service.SOURCE
    assert result["detected_type"] == "JPEG"
    assert result["width"] == 4
    assert result["height"] == 3
    assert result["mode"] == "RGB"
    assert result["pixel_count"] == 12
    assert result["has_exif"] is True

    names = {tag["name"] for tag in result["tags"]}
    assert {"Make", "Model", "Software", "Artist"} <= names
    assert "DateTimeOriginal" in names
    assert "LensModel" in names
    # IFD attribution is what makes the list navigable in the UI.
    assert {tag["ifd"] for tag in result["tags"]} >= {"IFD0", "Exif"}

    by_name = {tag["name"]: tag["value"] for tag in result["tags"]}
    assert by_name["Make"] == "Canon"
    assert by_name["Model"] == "Canon EOS 5D Mark IV"
    assert by_name["DateTimeOriginal"] == "2024:05:01 12:33:44"
    assert by_name["LensModel"] == "EF24-70mm f/2.8L II USM"


def test_output_is_json_serialisable_and_matches_the_documented_shape():
    import json

    result = extract(jpeg_with_exif(), filename="evidence.jpg", include_gps=True)
    # This dict is persisted into scans.result_snapshot and returned by the
    # API, so a non-JSON value here is a 500 at write time, not a cosmetic bug.
    assert json.loads(json.dumps(result)) == result

    for key in (
        "source",
        "ok",
        "rejected_reason",
        "detected_type",
        "declared_filename",
        "extension_mismatch",
        "width",
        "height",
        "pixel_count",
        "mode",
        "has_exif",
        "has_maker_note",
        "tags",
        "tag_count",
        "has_gps",
        "gps",
        "gps_withheld_reason",
        "has_device_serial",
        "device_serial",
        "device_serial_withheld_reason",
        "truncated",
        "note",
    ):
        assert key in result, f"missing documented key: {key}"


@pytest.mark.parametrize(
    "image_format",
    ["GIF", "PNG", "WEBP", "TIFF", "BMP"],
)
def test_detected_type_follows_the_bytes_not_the_extension(image_format):
    """GIF/PNG bytes named `.jpg` must still be reported as what they are.

    The whole security property of this module is that `detected_type` is a
    fact about the bytes. If a future change let the extension through, a
    `.png` that is really a ZIP would be labelled "PNG" and rendered as one.
    """
    raw = encode(image_format)

    result = extract(raw, filename="photo.jpg")

    assert result["ok"] is True
    assert result["detected_type"] == image_format
    assert result["extension_mismatch"] is True
    assert result["declared_filename"] == "photo.jpg"
    assert ".jpg" in result["note"]
    assert image_format in result["note"]
    assert "never from its name" in result["note"]


def test_a_matching_extension_is_not_reported_as_a_mismatch():
    result = extract(jpeg_with_exif(), filename="evidence.jpg")

    assert result["detected_type"] == "JPEG"
    assert result["extension_mismatch"] is False


def test_a_filename_with_no_extension_is_not_a_mismatch():
    result = extract(jpeg_with_exif(), filename="evidence")

    assert result["ok"] is True
    assert result["declared_filename"] == "evidence"
    assert result["extension_mismatch"] is False


def test_filename_is_display_only_and_never_gates_acceptance():
    """A file that cannot be an image is rejected whatever it is called."""
    raw = encode("GIF")

    for name in ("photo.jpg", "photo.png", "photo.exe", "", "x" * 400):
        result = extract(raw, filename=name)
        assert result["ok"] is True, name
        assert result["detected_type"] == "GIF", name

    rejected = extract(b"not an image at all", filename="totally-a-image.jpg")
    assert rejected["ok"] is False
    assert rejected["rejected_reason"]
    assert rejected["detected_type"] is None


def test_filename_path_components_are_discarded_from_the_echo():
    result = extract(jpeg_with_exif(), filename="../../../etc/passwd")

    assert result["ok"] is True
    assert result["declared_filename"] == "passwd"
    assert "/" not in result["declared_filename"]


def test_long_filename_is_truncated_to_the_documented_cap():
    result = extract(jpeg_with_exif(), filename="n" * 900 + ".jpg")

    assert result["ok"] is True
    assert len(result["declared_filename"]) == exif_service.MAX_FILENAME_CHARS


@pytest.mark.parametrize(
    ("raw", "label"),
    [
        (b"", "empty file"),
        (b"abc", "three bytes"),
        (b"\x00\x01\x02\x03\x04\x05\x06\x07" * 4, "arbitrary binary"),
        (b"PK\x03\x04" + b"\x00" * 60, "ZIP header"),
        (b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "PDF header"),
        (b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 32, "ELF header"),
        (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', "SVG"),
        (b"#!/bin/sh\nrm -rf /\n", "shell script"),
    ],
)
def test_non_image_payloads_are_rejected_cleanly_without_raising(raw, label):
    result = extract(raw, filename=f"{label}.jpg")

    assert result["ok"] is False, label
    assert result["rejected_reason"], label
    assert result["detected_type"] is None, label
    assert result["tags"] == [], label
    assert result["has_gps"] is False, label
    assert result["note"] == result["rejected_reason"], label


def test_a_png_named_file_that_is_really_a_zip_is_rejected_on_content():
    """The headline case from the TODO: `.png` extension, ZIP bytes."""
    result = extract(b"PK\x03\x04" + b"\x00" * 120, filename="totally-a.png")

    assert result["ok"] is False
    assert "ZIP" in result["rejected_reason"]
    assert "whatever the file is named" in result["rejected_reason"]


@pytest.mark.parametrize("keep", [0.5, 0.2])
@pytest.mark.parametrize("image_format", ["JPEG", "PNG", "BMP"])
def test_truncated_images_are_rejected_cleanly_without_raising(image_format, keep):
    raw = encode(image_format)
    cut = raw[: int(len(raw) * keep)]

    result = extract(cut, filename=f"truncated.{image_format.lower()}")

    assert result["ok"] is False
    assert result["rejected_reason"]
    assert result["tags"] == []


def test_a_garbage_exif_block_does_not_crash_the_parse():
    """Valid JPEG, APP1 segment that is not EXIF."""
    raw = b"\xff\xd8\xff\xe1\x00\x08" + b"\x00\x01\x02\x03\x04" + b"\xff\xd9"

    result = extract(raw, filename="garbage-app1.jpg")

    assert result["ok"] is False
    assert result["rejected_reason"]


# --------------------------------------------------------------------------
# 2. size cap
# --------------------------------------------------------------------------
def test_size_cap_fires_before_any_decode():
    oversized = b"\x89PNG\r\n\x1a\n" + b"\x00" * (exif_service.MAX_INPUT_BYTES + 1)

    result = extract(oversized, filename="huge.png")

    assert result["ok"] is False
    assert "10 MiB" in result["rejected_reason"]
    assert "over the" in result["rejected_reason"]
    assert result["detected_type"] is None, "must not have decoded anything"


def test_size_cap_boundary_accepts_exactly_the_cap():
    body = b"\x89PNG\r\n\x1a\n"
    padded = body + b"\x00" * (exif_service.MAX_INPUT_BYTES - len(body))
    assert len(padded) == exif_service.MAX_INPUT_BYTES

    result = extract(padded, filename="exact-cap.png")

    # Exactly at the cap is admitted to sniffing; the bytes are junk, so the
    # rejection is about the content, not about the size.
    assert "over the" not in result["rejected_reason"]


def test_documented_size_cap_is_ten_mebibytes():
    assert exif_service.MAX_INPUT_BYTES == 10 * 1024 * 1024


# --------------------------------------------------------------------------
# 3. decompression-bomb guard
# --------------------------------------------------------------------------
def test_decompression_bomb_above_pillows_own_limit_is_rejected():
    # 40000x40000 = 1.6e9 pixels, past 2x Pillow's default MAX_IMAGE_PIXELS, so
    # Pillow raises DecompressionBombError inside Image.open(). Caught, turned
    # into a clean rejection; nothing is decoded.
    result = extract(png_claiming(40_000, 40_000), filename="bomb.png")

    assert result["ok"] is False
    assert "bomb" in result["rejected_reason"].lower()
    assert result["pixel_count"] is None


def test_decompression_bomb_inside_our_own_pixel_cap_is_rejected():
    # 8000x8000 = 64M pixels: under Pillow's warning threshold (89,478,485),
    # over our 50M cap. This proves OUR cap is the binding guard and is
    # checked on the parsed header, before `load()`.
    result = extract(png_claiming(8_000, 8_000), filename="big.png")

    assert result["ok"] is False
    assert "50,000,000-pixel cap" in result["rejected_reason"]
    assert "Rejected before decoding" in result["rejected_reason"]


def test_our_pixel_cap_is_stricter_than_pillows():
    assert exif_service.MAX_PIXELS < Image.MAX_IMAGE_PIXELS


def test_a_normal_photo_is_not_hit_by_the_pixel_guard():
    result = extract(jpeg_with_exif(), filename="normal.jpg")

    assert result["ok"] is True
    assert result["pixel_count"] == 12


# --------------------------------------------------------------------------
# 4. GPS: presence reported, value withheld
# --------------------------------------------------------------------------
def test_gps_is_present_but_withheld_by_default():
    """The truthful-withholding test: presence without the value.

    If this regresses to `has_gps: False` the UI would tell the user a
    geotagged photo carries no location data, which is the exact lie the TODO
    warns about. If it regresses to leaking coordinates, it is a §7 PII leak.
    """
    result = extract(jpeg_with_exif(), filename="geo.jpg")

    assert result["ok"] is True
    assert result["has_gps"] is True
    assert result["gps"] is None
    assert result["gps_withheld_reason"] is not None
    assert "include_gps=True" in result["gps_withheld_reason"]
    assert "AGENTS.md" in result["gps_withheld_reason"]
    assert "withheld" in result["note"]


def test_gps_is_returned_when_explicitly_opted_in():
    result = extract(jpeg_with_exif(), filename="geo.jpg", include_gps=True)

    assert result["ok"] is True
    assert result["has_gps"] is True
    assert result["gps_withheld_reason"] is None
    assert isinstance(result["gps"], dict)

    gps = result["gps"]
    # 51 deg 30' 00" N, 0 deg 07' 00" E -> 51.5, 0.11666...
    assert gps["latitude"] == pytest.approx(51.5)
    assert gps["longitude"] == pytest.approx(0.0 + (7.0 / 60.0))
    assert gps["latitude_ref"] == "N"
    assert gps["longitude_ref"] == "E"
    assert float(gps["altitude"]) == pytest.approx(45.5)
    assert gps["date"] == "2024:05:01"


def test_southern_and_western_hemispheres_are_signed_negative():
    exif = build_exif(with_gps=True, with_serial=False)
    gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps_ifd[1] = "S"
    gps_ifd[2] = [33, 1, 0, 1, 0, 1]
    gps_ifd[3] = "W"
    gps_ifd[4] = [118, 1, 0, 1, 0, 1]

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["gps"]["latitude"] == pytest.approx(-33.0)
    assert result["gps"]["longitude"] == pytest.approx(-118.0)


def test_a_two_value_coordinate_reads_as_degrees_and_minutes():
    """Pin the documented ambiguity resolution.

    A two-rational latitude is legal on the wire and the two readings differ
    wildly (51/1 + 30/1 = 51.5 degrees, or 51/30 = 1.7 degrees). We read it as
    d/m; the test exists so the choice is a decision on record rather than an
    accident, and so a future refactor has to confront it.
    """
    exif = build_exif(with_gps=True, with_serial=False)
    gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps_ifd[2] = [51, 1, 30, 1]

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["gps"]["latitude"] == pytest.approx(51.5)


def test_a_nested_dms_block_reads_the_same_as_a_flat_one():
    """Both rational shapes must agree.

    Pillow's encoder rejects a nested GPS value outright (`abs(): 'tuple'`),
    so this cannot be built through `save(exif=...)` — it is a direct test of
    the parser's input tolerance instead, which is where the shape would
    actually arrive from if a different reader ever produced it.
    """
    assert exif_service._dms_degrees(((51, 1), (30, 1), (0, 1))) == pytest.approx(51.5)
    assert exif_service._dms_degrees((51.0, 1.0, 30.0, 1.0, 0.0, 1.0)) == pytest.approx(
        51.5
    )
    assert exif_service._dms_degrees([51, 1, 30, 1]) == pytest.approx(51.5)
    assert exif_service._dms_degrees((51.0, 1.0)) == pytest.approx(51.0)


@pytest.mark.parametrize(
    "value",
    [
        None,
        (),
        (51,),
        (51, 1, 30),  # odd number of components: not whole rationals
        (51, 0),  # zero denominator
        (51, 1, 30, 1, 0, 1, 5, 1),  # more than d/m/s
        "51 deg 30'",
        object(),
        float("nan"),
    ],
)
def test_malformed_coordinate_values_yield_none_instead_of_guessing(value):
    assert exif_service._dms_degrees(value) is None


def test_a_zero_denominator_rational_yields_no_coordinate_not_a_crash():
    exif = build_exif(with_gps=True, with_serial=False)
    exif.get_ifd(ExifTags.IFD.GPSInfo)[2] = [51, 0, 30, 1]

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["ok"] is True
    assert result["gps"]["latitude"] is None


def test_an_out_of_range_coordinate_is_rejected_not_wrapped():
    """999 degrees north is not a coordinate; it must not become one."""
    exif = build_exif(with_gps=True, with_serial=False)
    exif.get_ifd(ExifTags.IFD.GPSInfo)[2] = [999, 1, 0, 1, 0, 1]

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["ok"] is True
    assert result["gps"]["latitude"] is None


def test_gps_without_a_hemisphere_ref_yields_no_coordinate_not_a_guess():
    """No ref letter means the sign is unknown; we refuse to invent a side."""
    exif = build_exif(with_gps=True, with_serial=False)
    gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    del gps_ifd[1]
    del gps_ifd[3]

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["has_gps"] is True
    assert result["gps"]["latitude"] is None
    assert result["gps"]["longitude"] is None


def test_gps_tags_are_absent_from_the_tag_list_unless_opted_in():
    """Otherwise the dedicated field is bypassable via `tags`."""
    without = extract(jpeg_with_exif(), filename="geo.jpg")
    assert any(tag["ifd"] == "GPS" for tag in without["tags"]) is False
    assert not any("GPSLatitude" in tag["name"] for tag in without["tags"])

    with_optin = extract(jpeg_with_exif(), filename="geo.jpg", include_gps=True)
    assert any(tag["ifd"] == "GPS" for tag in with_optin["tags"]) is True


def test_a_file_without_gps_reports_no_gps_and_no_withheld_reason():
    result = extract(jpeg_with_exif(with_gps=False), filename="plain.jpg")

    assert result["ok"] is True
    assert result["has_gps"] is False
    assert result["gps"] is None
    assert result["gps_withheld_reason"] is None
    assert "GPS coordinates" not in result["note"]


# --------------------------------------------------------------------------
# 5. device serials: presence reported, value withheld
# --------------------------------------------------------------------------
def test_serial_is_present_but_withheld_by_default():
    result = extract(jpeg_with_exif(), filename="dumped.jpg")

    assert result["has_device_serial"] is True
    assert result["device_serial"] is None
    assert result["device_serial_withheld_reason"] is not None
    assert "include_serials=True" in result["device_serial_withheld_reason"]
    # The value must not leak anywhere in the payload.
    assert SERIAL not in repr(result)


def test_serial_is_returned_when_explicitly_opted_in():
    result = extract(jpeg_with_exif(), filename="dumped.jpg", include_serials=True)

    assert result["has_device_serial"] is True
    assert result["device_serial"] == SERIAL
    assert result["device_serial_withheld_reason"] is None
    body = {tag["name"]: tag["value"] for tag in result["tags"]}
    assert body["BodySerialNumber"] == SERIAL


def test_the_serial_is_redacted_inside_tags_when_withheld():
    """The dedicated field is not the only way in; `tags` must be redacted too."""
    result = extract(jpeg_with_exif(), filename="dumped.jpg")

    serials = [tag for tag in result["tags"] if tag["name"] == "BodySerialNumber"]
    assert serials, "the serial tag should still be visible by name"
    assert SERIAL not in serials[0]["value"]
    assert "withheld" in serials[0]["value"]
    assert "include_serials=True" in serials[0]["value"]


def test_a_file_without_a_serial_reports_no_serial():
    result = extract(jpeg_with_exif(with_serial=False), filename="clean.jpg")

    assert result["has_device_serial"] is False
    assert result["device_serial"] is None
    assert result["device_serial_withheld_reason"] is None


def test_a_maker_note_is_flagged_and_never_dumped_raw():
    """MakerNote lives in the Exif sub-IFD, and Pillow returns opaque bytes.

    Two things to pin: `has_maker_note` must be True (it is how the UI says
    "there is more here we cannot read"), and the bytes must not be echoed —
    they are vendor binary that can be arbitrarily long.
    """
    exif = build_exif(with_gps=False, with_serial=False)
    exif.get_ifd(ExifTags.IFD.Exif)[0x927C] = b"\x00\x01MACRO\x00opaque" * 40

    result = extract(encode("JPEG", exif=exif), filename="nikon.jpg")

    assert result["ok"] is True
    assert result["has_maker_note"] is True
    assert "NOT decoded" in result["note"]

    note = next(tag for tag in result["tags"] if tag["name"] == "MakerNote")
    assert "not decoded" in note["value"]
    assert len(note["value"]) <= exif_service.MAX_VALUE_CHARS
    # The size is reported, the content is not.
    assert "MACRO" not in note["value"]
    assert "bytes" in note["value"]


def test_a_file_without_a_maker_note_is_not_flagged():
    result = extract(jpeg_with_exif(), filename="canon.jpg")

    assert result["has_maker_note"] is False
    assert "NOT decoded" not in result["note"]


def test_gps_altitude_is_a_float_and_signs_below_sea_level():
    exif = build_exif(with_gps=True, with_serial=False)
    gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps_ifd[5] = 1  # GPSAltitudeRef 1 = below sea level
    gps_ifd[6] = 120.0

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert result["gps"]["altitude"] == pytest.approx(-120.0)
    assert isinstance(result["gps"]["latitude"], float)


def test_a_non_finite_altitude_never_reaches_the_response_as_nan():
    """A 1/0 rational is a legal hostile input and evaluates to NaN.

    `json.dumps` emits a bare `NaN` token for it, which is not valid JSON and
    will 500 on a strict parser downstream. It has to degrade to None.
    """
    import json

    from PIL.TiffImagePlugin import IFDRational

    gps = exif_service._build_gps(
        {1: "N", 2: (51, 1, 0, 1, 0, 1), 6: IFDRational(1, 0)}
    )

    assert gps["altitude"] is None
    assert gps["latitude"] == pytest.approx(51.0)
    json.dumps(gps)  # must not raise / must not emit a bare NaN


def test_a_below_sea_level_byte_ref_is_honoured():
    """GPSAltitudeRef is an EXIF BYTE; Pillow returns it as `b'\\x01'`.

    Read as a float it is None, so the sign branch never fires and a below-sea-
    level altitude renders as above sea level — plausible-looking and wrong.
    """
    assert exif_service._gps_byte_ref(b"\x01") == 1.0
    assert exif_service._gps_byte_ref(b"\x00") == 0.0
    assert exif_service._gps_byte_ref(1) == 1.0
    assert exif_service._gps_byte_ref(None) is None
    assert exif_service._gps_byte_ref(b"\x01\x02") is None


# --------------------------------------------------------------------------
# 6. truncation caps
# --------------------------------------------------------------------------
def test_tag_list_is_capped_and_truncation_is_declared():
    # 400 private IFD0 tags on top of the normal block: over the 200 cap.
    extra = {0xF001 + i: f"value-{i:03d}" for i in range(400)}
    result = extract(jpeg_with_exif(extra_ifd0=extra), filename="many.jpg")

    assert result["ok"] is True
    assert len(result["tags"]) == exif_service.MAX_TAGS
    assert result["truncated"] is True
    assert "dropped" in result["note"]


def test_a_tag_list_under_the_cap_is_not_marked_truncated():
    result = extract(jpeg_with_exif(), filename="few.jpg")

    assert len(result["tags"]) < exif_service.MAX_TAGS
    assert result["truncated"] is False


def test_long_tag_values_are_truncated_to_the_documented_cap():
    huge = "b" * 20_000
    result = extract(
        jpeg_with_exif(artist_chars=0, extra_ifd0={ExifTags.Base.Artist: huge}),
        filename="wordy.jpg",
    )

    artist = next(tag for tag in result["tags"] if tag["name"] == "Artist")
    assert artist["value"] == "b" * exif_service.MAX_VALUE_CHARS
    assert len(artist["value"]) == 2048


def test_tag_and_value_caps_match_the_spec():
    assert exif_service.MAX_VALUE_CHARS == 2048
    assert exif_service.MAX_TAGS == 200


def test_a_very_long_gps_string_value_is_truncated():
    exif = build_exif(with_gps=True, with_serial=False)
    exif.get_ifd(ExifTags.IFD.GPSInfo)[9] = "g" * 5_000  # GPSStatus

    result = extract(encode("JPEG", exif=exif), include_gps=True)

    assert len(result["gps"]["status"]) <= exif_service.MAX_GPS_VALUE_CHARS


def test_control_characters_are_stripped_from_echoed_values():
    result = extract(
        jpeg_with_exif(
            extra_ifd0={ExifTags.Base.Copyright: "ok\x1b[31mRED\x07\x00\x1b[2J"}
        ),
        filename="evil.jpg",
    )

    value = next(tag["value"] for tag in result["tags"] if tag["name"] == "Copyright")
    assert "\x1b" not in value
    assert "\x07" not in value
    assert "\x00" not in value
    assert "[31m" not in value, "the whole escape sequence must go, not just ESC"
    assert "[2J" not in value


# --------------------------------------------------------------------------
# 7. the Pillow-not-exiftool guarantee
# --------------------------------------------------------------------------
def test_module_shells_out_to_nothing():
    """AST-parse the module and prove there is no exec surface.

    This is the test that pins the Pillow-over-exiftool decision. `exiftool`
    would require `subprocess` (or `os.system`, `ctypes`, `pty`, `runpy`);
    none of those may appear, and no call may resolve to one.
    """
    tree = ast.parse(SERVICE_PATH.read_text(encoding="utf-8"))

    banned_modules = {
        "subprocess",
        "os",
        "pty",
        "shlex",
        "runpy",
        "importlib",
        "tempfile",
        "ctypes",
        "multiprocessing",
        "shutil",
        "signal",
        "code",
    }
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            imported.add(node.module.split(".")[0])

    assert (
        imported & banned_modules == set()
    ), f"banned imports: {imported & banned_modules}"
    assert imported <= {
        "io",
        "math",
        "re",
        "typing",
        "PIL",
        "__future__",
        "app",
    }, f"unexpected imports: {sorted(imported)}"

    banned_calls = {
        "system",
        "popen",
        "Popen",
        "run",
        "call",
        "check_call",
        "check_output",
        "spawnl",
        "spawnv",
        "execv",
        "execve",
        "fork",
        "load_library",
        "CDLL",
        "windll",
        "cdll",
        "eval",
        "exec",
        "__import__",
    }
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute):
            name = func.attr
        elif isinstance(func, ast.Name):
            name = func.id
        else:
            continue
        if name in banned_calls:
            offenders.append(f"line {node.lineno}: {name}()")

    assert offenders == [], f"exec surface found: {offenders}"


def test_exiftool_appears_only_in_the_prose_never_in_code():
    """The tool name belongs in the docstring explaining why it was rejected.

    If someone later wires it up "just for the formats Pillow misses", this
    fails: the name would have to move out of the module docstring and into an
    actual call, which is the review conversation the TODO said needed approval.
    """
    tree = ast.parse(SERVICE_PATH.read_text(encoding="utf-8"))
    docstring = ast.get_docstring(tree) or ""
    # The docstring node itself, by identity — `get_docstring` returns a fresh
    # string, so it cannot be used to exclude the node from the walk.
    docstring_node = tree.body[0].value if ast.get_docstring(tree) else None

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if node is docstring_node:
            continue
        if "exiftool" in node.value.lower():
            offenders.append(f"line {node.lineno}: {node.value[:60]!r}")

    assert offenders == [], f"exiftool referenced in code: {offenders}"
    assert "exiftool" in docstring
    # And the rejection rationale must name the reason, not just the tool.
    assert "binary" in docstring.lower()


def test_module_docstring_states_the_tradeoff():
    source = SERVICE_PATH.read_text(encoding="utf-8")

    assert "exiftool" in source
    assert "Pillow" in source
    assert "maker note" in source.lower()


# --------------------------------------------------------------------------
# 8. stripping on store
# --------------------------------------------------------------------------
def test_strip_for_store_removes_the_values_and_keeps_the_presence():
    live = extract(
        jpeg_with_exif(), filename="geo.jpg", include_gps=True, include_serials=True
    )
    assert live["gps"] is not None
    assert live["device_serial"] == SERIAL

    stored = strip_for_store(live)

    assert stored["gps"] is None
    assert stored["device_serial"] is None
    assert stored["has_gps"] is True
    assert stored["has_device_serial"] is True
    assert stored["gps_withheld_reason"] == "stripped before storage"
    assert stored["device_serial_withheld_reason"] == "stripped before storage"
    assert SERIAL not in repr(stored)
    assert stored["tags"], "metadata about the file is still kept"
    # The original must not be mutated: a caller may still need the live copy.
    assert live["gps"] is not None


def test_strip_for_store_is_idempotent():
    once = strip_for_store(
        extract(jpeg_with_exif(), include_gps=True, include_serials=True)
    )
    twice = strip_for_store(once)

    assert twice == once


def test_strip_for_store_leaves_a_clean_file_alone():
    clean = extract(
        jpeg_with_exif(with_gps=False, with_serial=False), filename="clean.jpg"
    )

    stored = strip_for_store(clean)

    assert stored["has_gps"] is False
    assert stored["gps_withheld_reason"] is None
    assert stored["device_serial"] is None
    assert stored["tags"] == clean["tags"]


# --------------------------------------------------------------------------
# 9. contract details
# --------------------------------------------------------------------------
def test_wrong_argument_types_raise_type_error():
    with pytest.raises(TypeError, match="bytes-like"):
        extract("not bytes")  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="bytes-like"):
        extract(None)  # type: ignore[arg-type]

    with pytest.raises(TypeError, match="filename"):
        extract(jpeg_with_exif(), filename=123)  # type: ignore[arg-type]


@pytest.mark.parametrize("container", [bytearray, memoryview])
def test_bytearray_and_memoryview_are_accepted(container):
    raw = jpeg_with_exif()

    result = extract(container(raw), filename="photo.jpg")

    assert result["ok"] is True
    assert result["detected_type"] == "JPEG"


def test_the_function_does_not_mutate_global_pillow_state():
    """`Image.MAX_IMAGE_PIXELS` must be left exactly as Pillow shipped it.

    A service that lowered the global to suit itself would tighten every other
    Pillow user in the process, and could not be reasoned about per-request.
    """
    before_pixels = Image.MAX_IMAGE_PIXELS

    extract(png_claiming(40_000, 40_000), filename="bomb.png")
    extract(jpeg_with_exif(), filename="ok.jpg")

    assert Image.MAX_IMAGE_PIXELS == before_pixels


def test_every_result_carries_a_note():
    assert extract(jpeg_with_exif(), filename="a.jpg")["note"]
    assert extract(b"nope", filename="b.jpg")["note"]
    assert extract(
        jpeg_with_exif(extra_ifd0={0xF001 + i: "x" for i in range(400)}),
        filename="c.jpg",
    )["note"]


def test_png_exif_is_read_too():
    """Pillow writes a real eXIf chunk into PNG; the claim is not JPEG-only."""
    raw = encode("PNG", exif=build_exif(with_gps=False, with_serial=False))

    result = extract(raw, filename="shot.png")

    assert result["ok"] is True
    assert result["detected_type"] == "PNG"
    assert result["has_exif"] is True
    assert {tag["name"] for tag in result["tags"]} >= {"Make", "Model"}


def test_a_format_that_cannot_carry_exif_still_parses_cleanly():
    raw = encode("GIF")

    result = extract(raw, filename="anim.gif")

    assert result["ok"] is True
    assert result["detected_type"] == "GIF"
    assert result["has_exif"] is False
    assert result["tags"] == []
    assert result["has_gps"] is False
    assert result["has_device_serial"] is False


def test_declared_filename_is_none_when_no_filename_is_given():
    result = extract(jpeg_with_exif())

    assert result["ok"] is True
    assert result["declared_filename"] is None
    assert result["extension_mismatch"] is False
