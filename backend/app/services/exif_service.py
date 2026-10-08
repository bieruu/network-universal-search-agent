"""EXIF / image-metadata viewer for user-supplied upload bytes.

WHAT THIS IS
    A pure, synchronous function over bytes that are ALREADY in memory:
    `extract(data)` returns a JSON-serialisable dict describing the image and
    its EXIF block, or a clean rejection. It reads no file, writes no file,
    opens no socket, touches no global Pillow state. The calling router owns
    reading the upload; this module only parses.

WHY PILLOW AND NOT `exiftool`
    The TODO named `exiftool`, and that was the wrong tool for a server that
    parses bytes an anonymous user just uploaded. The alternative is Pillow,
    which is already a pinned dependency (`pillow==12.3.0`):

    * No new system binary in the container image. `exiftool` is a Perl
      program plus a large tag database; shipping it means a second parser to
      patch, and CVEs in it are CVEs in the OSINT dashboard.
    * No shell-out to parse untrusted bytes. `exiftool -json -` means
      interpolating attacker-controlled data into a subprocess boundary (argv
      is safe, PATH is not, and `os.environ` is attacker-influenced in some
      deployment shapes). It also re-introduces a `PATH`/exec surface that
      AGENTS.md §5 does not currently have.
    * No temp file. `exiftool` wants a path, so the usual pattern is to spill
      the upload to disk — which turns an upload endpoint into a
      world-writable-file path bug.

    THE TRADE-OFF, STATED PLAINLY: exiftool covers dozens of container formats
    (HEIC/HEIF, AVIF, RAW/CR2/NEF/ARW, MP4/MOV/GoPro, PDF, ICC, ...) and
    decodes vendor maker-note tags. Pillow covers EXIF in JPEG, TIFF, PNG,
    WebP, GIF and BMP, does NOT decode maker notes at all, and never saw the
    RAW formats. So a camera RAW file or an iPhone HEIC upload is a rejection
    here where exiftool would have answered. That is a real loss of coverage
    and it is the price paid for the three bullets above. `has_maker_note`
    exists so the UI can say "there is more in here we cannot read" rather
    than implying the tag list is complete.

RENDER-ONLY BY DEFAULT, PERSISTENCE OPT-IN
    EXIF routinely carries GPS coordinates and device serial numbers. Under
    AGENTS.md §7 ("don't store raw secrets/PII beyond audit minimum") a
    coordinate picked off a found photo is PII we have no audit-minimum reason
    to retain, so the default response must not include one.

    The obvious wrong implementation is to delete the GPS tags and stay quiet.
    That is not a privacy control, it is a lie: the user then believes a photo
    carries no location data when it does, and the one case where the metadata
    mattered most is the one case they were told was clean. So this module
    reports PRESENCE truthfully and withholds VALUE:

        has_gps=True, gps=None, gps_withheld_reason="..."
        has_device_serial=True, device_serial=None, <reason>

    `include_gps=True` / `include_serials=True` are the explicit opt-in, and
    the reason strings name them so the UI can render an actionable button
    instead of a shrug. Withheld values are also redacted inside `tags`, so
    the flag cannot be bypassed by reading the tag list instead of the
    dedicated field. `strip_for_store()` implements the "stripping on store"
    half of the TODO for whichever caller ends up persisting a result.

ERROR CONTRACT
    - `data` not bytes-like -> TypeError (a caller bug, not an attack).
    - `filename` not str/None -> TypeError.
    - EVERYTHING else returns a dict. Oversized, non-image, corrupt,
      truncated, unsupported and bomb-shaped input all come back as
      `{"ok": False, "rejected_reason": "..."}` with every other key present
      and empty. This function never raises on hostile input, so a router can
      never turn a bad upload into a 500 (AGENTS.md §5.4).

LIMITS (all attacker-controlled, all bounded)
    MAX_INPUT_BYTES 10 MiB on the raw upload, checked before any decode.
    MAX_PIXELS      50M decoded pixels, checked after the header is parsed but
                    before `load()`. Pillow raises its own
                    `DecompressionBombError` above 2x its default
                    `MAX_IMAGE_PIXELS`; that is caught too, so the guard is
                    ours and Pillow's, not either-or.
    MAX_TAGS        200 entries, with `truncated` set when more existed.
    MAX_VALUE_CHARS 2048 per tag value.
"""

from __future__ import annotations

import io
import math
import re
from typing import Any

from PIL import ExifTags, Image
from PIL.TiffImagePlugin import IFDRational

SOURCE = "EXIF (image metadata)"

# --- caps -------------------------------------------------------------------
# 10 MiB. A scan dashboard renders a metadata table, not the photo itself, so
# the payload we need is a few KB at most; anything much larger is a
# denial-of-service attempt rather than a photo a user forgot to crop.
MAX_INPUT_BYTES = 10 * 1024 * 1024
# 50M pixels ~= a 7500x6600 raw-sized frame, ~150 MB decoded as RGB. Above
# Pillow's own default MAX_IMAGE_PIXELS (89,478,485), so our cap is the
# binding one for anything between the two.
MAX_PIXELS = 50_000_000
MAX_TAGS = 200
MAX_VALUE_CHARS = 2048
MAX_NAME_CHARS = 80
MAX_FILENAME_CHARS = 255
MAX_NOTE_CHARS = 400
MAX_GPS_VALUE_CHARS = 64
# Guard against a tag value that is a 100k-element sequence: build a bounded
# preview, never the whole thing, and never a length-inflated join.
MAX_SEQUENCE_ITEMS = 32
MAX_HEX_PREVIEW_BYTES = 32

# Formats Pillow can decode AND that we are willing to accept. GIF and BMP
# cannot carry EXIF at all, and are still accepted on purpose: a GIF named
# `.jpg` is a real thing a user will upload, and rejecting it would teach
# them the tool is lying about file types. We report `has_exif: false` instead.
SUPPORTED_FORMATS = frozenset({"JPEG", "PNG", "GIF", "WEBP", "TIFF", "BMP"})

# Extension -> the format name Pillow reports for it. Display-side only: this
# map is NEVER consulted to decide whether a file is accepted or what type it
# is. It exists solely to compute `extension_mismatch`.
_EXT_TO_FORMAT: dict[str, str] = {
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "jpe": "JPEG",
    "jfif": "JPEG",
    "jif": "JPEG",
    "png": "PNG",
    "apng": "PNG",
    "gif": "GIF",
    "webp": "WEBP",
    "tif": "TIFF",
    "tiff": "TIFF",
    "bmp": "BMP",
    "dib": "BMP",
}

# Magic bytes for containers that are definitely NOT a supported raster image.
# This table can only ever improve the *wording* of a rejection: nothing here
# can make a file acceptable, and every verdict about image type still comes
# from Pillow sniffing the bytes. A `photo.png` that is really a ZIP lands
# here and is refused on content, never on its name.
_MAGIC_NON_IMAGE: tuple[tuple[bytes, str], ...] = (
    (b"PK\x03\x04", "ZIP archive"),
    (b"PK\x05\x06", "ZIP archive"),
    (b"PK\x07\x08", "ZIP archive"),
    (b"%PDF", "PDF document"),
    (b"\x7fELF", "ELF executable"),
    (b"MZ", "DOS/Windows executable"),
    (b"\x1f\x8b", "gzip stream"),
    (b"BZh", "bzip2 stream"),
    (b"\xfd7zXZ\x00", "xz stream"),
    (b"7z\xbc\xaf\x27\x1c", "7-Zip archive"),
    (b"Rar!\x1a\x07", "RAR archive"),
    (b"SQLite format 3\x00", "SQLite database"),
    (b"\x00\x00\x00\x00ftypavif", "AVIF container"),
    (b"\x00\x00\x00\x18ftypheic", "HEIC/HEIF container"),
    (b"\x00\x00\x00\x0cftypmif1", "HEIF container"),
)

# C0/C1 controls and DEL. EXIF string fields are attacker-controlled and get
# rendered as plain text (AGENTS.md §5.3), so terminal escapes and log-forging
# newlines are stripped from every echoed value. `_ANSI_RE` removes the whole
# CSI/Fe sequence rather than just the ESC byte, so a pasted escape cannot
# leave "[31m" glued onto the text it was colouring.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
_WHITESPACE_RE = re.compile(r"\s+")

# Sub-IFD pointers and SubIFDs. Present in IFD0 as an *offset*, which is noise
# for a human and a false-positive-looking number in a UI table; the real
# contents are read from their own IFD instead.
_POINTER_TAGS = frozenset({0x8769, 0x8825, 0xA005, 0x014A})

# EXIF 2.3 defines exactly one serial tag, 0xA431 BodySerialNumber, and it is
# the de-facto one across Canon/Nikon/Samsung/Olympus/GoPro. 0xA435 is Nikon
# LensData's LensSerialNumber. These two are what we can honestly detect.
# MakerNote (0x927C) frequently embeds a serial too, but Pillow returns it as
# opaque bytes and we do not decode it — see the module docstring.
_SERIAL_TAGS: dict[int, str] = {
    0xA431: "BodySerialNumber",
    0xA435: "LensSerialNumber",
}
_MAKER_NOTE_TAG = 0x927C

# GPS IFD tag -> field name in the `gps` dict. Deliberately a curated subset:
# speed and image direction are genuinely useful for photo geolocation work,
# and everything else in the GPS IFD is either redundant or a version byte.
_GPS_FIELDS: dict[int, str] = {
    1: "latitude_ref",
    2: "latitude",
    3: "longitude_ref",
    4: "longitude",
    5: "altitude_ref",
    6: "altitude",
    7: "timestamp_utc",
    8: "satellites",
    9: "status",
    10: "measure_mode",
    11: "dop",
    12: "speed_ref",
    13: "speed",
    16: "image_direction_ref",
    17: "image_direction",
    18: "map_datum",
    29: "date",
    30: "differential",
}

_GPS_WITHHELD_REASON = (
    "This file carries GPS coordinates. They are withheld by default: "
    "location data is PII outside the audit minimum (AGENTS.md 7). Re-run "
    "with include_gps=True to see them."
)
_SERIAL_WITHHELD_REASON = (
    "This file carries a device serial number. It is withheld by default: "
    "a serial is PII outside the audit minimum (AGENTS.md 7). Re-run with "
    "include_serials=True to see it."
)
_SERIAL_TAG_WITHHELD = "[withheld: device serial - re-run with include_serials=True]"

# Pillow's own coverage caveat, on every result, because an incomplete tag
# list presented as a complete one is the failure mode of every EXIF viewer.
_COVERAGE_NOTE = (
    "Parsed with Pillow: EXIF in JPEG/TIFF/PNG/WebP only. Maker notes and "
    "camera RAW are not decoded."
)


class _Reject(Exception):
    """Internal control-flow signal carrying a user-facing rejection reason."""


def _clean(value: str) -> str:
    """Strip control/escape characters and collapse whitespace. Never raises."""
    return _WHITESPACE_RE.sub(" ", _CONTROL_RE.sub("", _ANSI_RE.sub("", value))).strip()


def _clip(value: str, limit: int) -> str:
    return _clean(value)[:limit]


def _ratio_text(value: Any) -> str:
    """Render a rational as `num/den`, which survives what a float would lose."""
    num = getattr(value, "numerator", None)
    den = getattr(value, "denominator", None)
    if num is None or den is None:
        return _clip(str(value), MAX_VALUE_CHARS)
    try:
        if float(den) == 0.0:
            return f"{num}/0"
    except (TypeError, ValueError, OverflowError):
        return _clip(str(value), MAX_VALUE_CHARS)
    return f"{num}/{den}"


def _number_text(value: float) -> str:
    # nan/inf are legitimate outcomes of a hostile rational such as 1/0 and
    # are reported as such rather than crashing the formatter.
    if not math.isfinite(value):
        return str(value)
    return f"{value:.7f}".rstrip("0").rstrip(".") or "0"


def _stringify(value: Any, *, tuples_are_rationals: bool = False) -> str:
    """Render an attacker-controlled EXIF value as bounded, plain text.

    Every branch is bounded before it is formatted. `repr()` is never used on
    raw values: it is how a 10 MB bytes value becomes a 30 MB string in a JSON
    response and a 30 MB log line.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, IFDRational):
        return _ratio_text(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number_text(value)
    if isinstance(value, str):
        return _clip(value, MAX_VALUE_CHARS)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        if not raw:
            return "<empty>"
        head = raw[:MAX_HEX_PREVIEW_BYTES].hex(" ")
        tail = " ..." if len(raw) > MAX_HEX_PREVIEW_BYTES else ""
        return _clip(f"<{len(raw)} bytes, hex: {head}>{tail}", MAX_VALUE_CHARS)
    if isinstance(value, (tuple, list)):
        items = list(value)
        shown = items[:MAX_SEQUENCE_ITEMS]
        if tuples_are_rationals:
            parts = [
                (
                    _ratio_text(item)
                    if isinstance(item, (tuple, list)) and len(item) == 2
                    else _stringify(item)
                )
                for item in shown
            ]
        else:
            parts = [_stringify(item) for item in shown]
        if len(items) > MAX_SEQUENCE_ITEMS:
            parts.append(f"...+{len(items) - MAX_SEQUENCE_ITEMS} more")
        return _clip(", ".join(parts), MAX_VALUE_CHARS)
    return _clip(f"<{type(value).__name__}>", MAX_VALUE_CHARS)


def _to_float(value: Any) -> float | None:
    """Read a scalar EXIF value as a float. Returns None on any doubt.

    Handles a scalar, an `IFDRational`, and a bare `(numerator, denominator)`
    pair — which is how a single rational such as GPSAltitude comes back. Any
    longer sequence is ambiguous and returns None rather than guessing; GPS
    coordinates go through `_dms_degrees` instead.

    Returns None rather than a guess: a fabricated coordinate is worse than a
    missing one, because a coordinate gets plotted on a map.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (tuple, list)):
        items = list(value)
        if len(items) != 2 or any(isinstance(item, (tuple, list)) for item in items):
            return None
        num = _to_float(items[0])
        den = _to_float(items[1])
        if num is None or den is None or den == 0.0:
            return None
        return num / den
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _dms_degrees(value: Any) -> float | None:
    """Read a GPS latitude/longitude into unsigned decimal degrees.

    The EXIF spec stores these as THREE rationals — degrees, minutes, seconds
    — and Pillow hands back a FLAT sequence of numerator/denominator pairs, so
    a spec-conformant 51/30/0 arrives as the 6-tuple
    ``(51.0, 1.0, 30.0, 1.0, 0.0, 1.0)``. Nested 2-sequences are flattened
    first, so a hand-built block shaped ``((51,1),(30,1),(0,1))`` reads the
    same way.

    A 2-pair result is read as degrees + minutes rather than as one rational.
    Both are legal on the wire and they disagree (51/1 + 30/1 is 51.5 degrees;
    as a single rational it is 1.7), but a two-value latitude in the wild is
    far more likely to be a camera omitting seconds than a camera storing a
    fraction of a degree — a bare rational latitude would place nearly every
    photo within a degree of the prime meridian. The ±90/±180 bound in
    `_signed_decimal` catches the cases where this reading is still nonsense.
    """
    flat: list[float] = []

    def _flatten(item: Any) -> bool:
        if isinstance(item, (tuple, list)):
            return all(_flatten(part) for part in item)
        number = _to_float(item)
        if number is None:
            return False
        flat.append(number)
        return True

    if not _flatten(value):
        return None
    if len(flat) < 2 or len(flat) % 2 != 0:
        return None

    parts: list[float] = []
    for index in range(0, len(flat), 2):
        num, den = flat[index], flat[index + 1]
        if den == 0.0:
            return None
        parts.append(num / den)
    if not parts:
        return None

    degrees = parts[0]
    if len(parts) >= 2:
        degrees += parts[1] / 60.0
    if len(parts) >= 3:
        degrees += parts[2] / 3600.0
    if len(parts) > 3:
        return None
    return degrees if math.isfinite(degrees) else None


def _gps_byte_ref(value: Any) -> float | None:
    """Read an EXIF BYTE-valued GPS tag (e.g. GPSAltitudeRef) as a number.

    GPSAltitudeRef and friends are type BYTE, and Pillow hands them back as
    `b'\\x01'` rather than the integer 1. Reading it as a float yields None,
    which silently turns every below-sea-level altitude into an above-sea-level
    one — the kind of error that looks plausible in a rendered table.
    """
    if isinstance(value, (bytes, bytearray)) and len(value) == 1:
        return float(value[0])
    return _to_float(value)


def _signed_decimal(value: Any, ref: Any, *, limit: float) -> float | None:
    """Convert a GPS DMS value to signed decimal degrees using its ref tag.

    An absent or unrecognised hemisphere letter yields None on purpose: the
    magnitude is known but the sign is not, and guessing "north" would place
    the photo in the wrong half of the planet.
    """
    magnitude = _dms_degrees(value)
    if magnitude is None or abs(magnitude) > limit:
        return None
    letter = _clean(str(ref)).upper() if ref is not None else ""
    if letter in {"N", "E"}:
        return magnitude
    if letter in {"S", "W"}:
        return -magnitude
    return None


def _tag_name(tag: int, *, gps_ifd: bool) -> str:
    table = ExifTags.GPSTAGS if gps_ifd else ExifTags.TAGS
    return _clip(table.get(tag) or f"Tag{tag}", MAX_NAME_CHARS)


def _gps_field(tag: int) -> str | None:
    return _GPS_FIELDS.get(tag)


def _declared_extension(filename: str | None) -> str:
    """Lower-cased extension of a display-only filename, without touching the OS.

    Any path component the client sent is discarded first: `../../etc/passwd`
    is a filename here, not a path, and nothing in this module opens it.
    """
    if not filename:
        return ""
    base = _display_filename(filename)
    dot = base.rfind(".")
    if dot <= 0:
        # dot == 0 is a dotfile (".bashrc"), not an extension.
        return ""
    return base[dot + 1 :].lower()[:MAX_NAME_CHARS]


def _display_filename(filename: str) -> str:
    """The basename of a client-supplied name, cleaned and clipped.

    Any path the client sent is discarded: `../../etc/passwd` is a filename
    here, not a path. Nothing in this module opens it, but a scan-history row
    echoing a traversal string back into a table is still a phishing-grade
    rendering, and it costs one line to not do it.
    """
    base = _clean(filename.replace("\\", "/").rsplit("/", 1)[-1])
    return base[:MAX_FILENAME_CHARS]


def _blank_result(filename: str | None) -> dict[str, Any]:
    """The full result shape with nothing filled in.

    Rejections reuse this so a caller never has to branch on a missing key.
    """
    return {
        "source": SOURCE,
        "ok": False,
        "rejected_reason": None,
        "detected_type": None,
        "declared_filename": (
            _display_filename(filename) if filename is not None else None
        ),
        "extension_mismatch": False,
        "width": None,
        "height": None,
        "pixel_count": None,
        "mode": None,
        "has_exif": False,
        "has_maker_note": False,
        "tags": [],
        "tag_count": 0,
        "has_gps": False,
        "gps": None,
        "gps_withheld_reason": None,
        "has_device_serial": False,
        "device_serial": None,
        "device_serial_withheld_reason": None,
        "truncated": False,
        "note": "",
    }


def _reject(result: dict[str, Any], reason: str) -> dict[str, Any]:
    result["ok"] = False
    result["rejected_reason"] = _clip(reason, MAX_NOTE_CHARS)
    result["note"] = _clip(reason, MAX_NOTE_CHARS)
    return result


def _sniff_non_image(raw: bytes) -> str | None:
    """Name the container if these bytes are a known non-image format.

    Returns None to mean "let Pillow decide". This function has no authority
    to accept anything; it only upgrades "cannot identify image file" into a
    sentence the user can act on.
    """
    for magic, label in _MAGIC_NON_IMAGE:
        if raw.startswith(magic):
            return label
    return None


def _open_verified(raw: bytes) -> tuple[Image.Image, str, int, int, str]:
    """Open on content, verify, then reopen and force a full decode.

    Three separate steps on purpose:

    1. `Image.open()` reads only the header. That is where content-based type
       sniffing happens and where Pillow's own `DecompressionBombError` fires.
    2. Our `MAX_PIXELS` check runs on the parsed header, BEFORE any pixel is
       decoded — a header claiming 20000x20000 costs us nothing to reject.
    3. `verify()` catches structural corruption; a forced `load()` on a fresh
       handle catches a truncated pixel stream (PNG/BMP raise `OSError` here
       while the format still identifies fine), which is the difference
       between "this file is damaged" and a crash on load.

    `verify()` leaves the image unusable, hence the second handle. Pillow's
    `DecompressionBombWarning` is deliberately left as a warning: converting
    it to an error needs `warnings.catch_warnings()`, which mutates
    process-global filter state and is documented as not thread-safe — a poor
    trade in an async app that runs this in a thread. Our own MAX_PIXELS check
    covers the band where Pillow only warns, so nothing is lost.
    """
    try:
        probe = Image.open(io.BytesIO(raw))
    except Image.DecompressionBombError as exc:
        raise _Reject(f"Rejected: Pillow's decompression-bomb guard fired ({exc}).")
    except Image.UnidentifiedImageError as exc:
        raise _Reject(f"Not a recognisable image ({exc}).")
    except (OSError, ValueError, SyntaxError, MemoryError) as exc:
        raise _Reject(f"The image header could not be read ({exc}).")

    with probe:
        detected = probe.format or "unknown"
        width, height = probe.size
        mode = probe.mode
        pixels = max(1, width) * max(1, height)
        if detected not in SUPPORTED_FORMATS:
            supported = ", ".join(sorted(SUPPORTED_FORMATS))
            raise _Reject(
                f"Detected {detected} from the file's own bytes, which this "
                f"viewer does not accept. Supported: {supported}."
            )
        if pixels > MAX_PIXELS:
            raise _Reject(
                f"Rejected before decoding: the header claims {width}x{height} "
                f"= {pixels:,} pixels, over the {MAX_PIXELS:,}-pixel cap."
            )
        try:
            probe.verify()
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
            raise _Reject(f"The image is corrupt or incomplete ({exc}).")

    try:
        full = Image.open(io.BytesIO(raw))
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise _Reject(f"The image could not be reopened for decoding ({exc}).")
    return full, detected, width, height, mode


def _read_ifd(exif: Any, tag: Any) -> dict[Any, Any]:
    """Read a sub-IFD, degrading to empty rather than failing the request.

    A hostile offset in the header can send a real parser off into garbage;
    one unreadable sub-IFD costs the user that sub-IFD's rows, not the scan.
    """
    try:
        return dict(exif.get_ifd(tag))
    except (KeyError, ValueError, TypeError, OSError, SyntaxError, IndexError):
        return {}


def _build_tags(
    exif: Any,
    *,
    include_gps: bool,
    include_serials: bool,
) -> tuple[list[dict[str, str]], bool, bool, int]:
    """Flatten IFD0 + Exif + Interop + (GPS) + IFD1 into one capped list.

    Returns `(tags, truncated, saw_maker_note, total_seen)` where `total_seen`
    counts every real entry across every IFD, before the cap. The caller needs
    it to report how many rows the UI is not showing.

    GPS entries appear only when `include_gps=True`, and serial values are
    replaced with a marker otherwise — otherwise the dedicated `gps` /
    `device_serial` fields could be bypassed by reading `tags` instead, which
    would make the whole opt-in theatre.
    """
    ifds: list[tuple[str, dict[Any, Any], bool]] = [
        ("IFD0", dict(exif), False),
        ("Exif", _read_ifd(exif, ExifTags.IFD.Exif), False),
        ("Interop", _read_ifd(exif, ExifTags.IFD.Interop), False),
    ]
    if include_gps:
        ifds.append(("GPS", _read_ifd(exif, ExifTags.IFD.GPSInfo), True))
    # IFD1 (the embedded thumbnail) last: its tags are the least useful, so
    # the cap should eat them first.
    ifds.append(("IFD1", _read_ifd(exif, ExifTags.IFD.IFD1), False))

    total = 0
    saw_maker_note = False
    tags: list[dict[str, str]] = []
    for ifd_name, mapping, is_gps in ifds:
        for tag_id, value in mapping.items():
            if not isinstance(tag_id, int) or tag_id in _POINTER_TAGS:
                continue
            if tag_id == _MAKER_NOTE_TAG:
                # Per the EXIF spec MakerNote lives in the Exif sub-IFD, not
                # IFD0 — gating this on IFD0 made has_maker_note report False
                # for exactly the files that have one.
                saw_maker_note = True
                raw = bytes(value) if isinstance(value, (bytes, bytearray)) else b""
                tags.append(
                    {
                        "name": _tag_name(tag_id, gps_ifd=is_gps),
                        "value": (
                            f"<maker note, {len(raw)} bytes, not decoded>"
                            if raw
                            else "<maker note, not decoded>"
                        ),
                        "ifd": ifd_name,
                    }
                )
                total += 1
                continue
            if tag_id in _SERIAL_TAGS and not include_serials:
                text = _SERIAL_TAG_WITHHELD
            else:
                text = _stringify(value, tuples_are_rationals=is_gps)
            tags.append(
                {
                    "name": _tag_name(tag_id, gps_ifd=is_gps),
                    "value": text,
                    "ifd": ifd_name,
                }
            )
            total += 1

    # Counted against the cap, not against the list we just built — comparing
    # `total > len(tags)` here can never be true and would report a 5000-tag
    # block as complete.
    truncated = total > MAX_TAGS
    return tags[:MAX_TAGS], truncated, saw_maker_note, total


def _build_gps(gps_ifd: dict[Any, Any]) -> dict[str, Any]:
    """Turn a GPS IFD into a small named dict with decimal lat/lon."""
    out: dict[str, Any] = {name: None for name in _GPS_FIELDS.values()}
    for tag_id, value in gps_ifd.items():
        field = _gps_field(tag_id) if isinstance(tag_id, int) else None
        if field is None:
            continue
        if field in {"latitude", "longitude"}:
            continue
        out[field] = _clip(_stringify(value), MAX_GPS_VALUE_CHARS) or None

    out["latitude"] = _signed_decimal(gps_ifd.get(2), gps_ifd.get(1), limit=90.0)
    out["longitude"] = _signed_decimal(gps_ifd.get(4), gps_ifd.get(3), limit=180.0)
    # Altitude is a float like lat/lon, not a formatted string. `_to_float`
    # already rejects nan/inf (a 1/0 rational yields one), so this can never
    # put a non-JSON-valid NaN into a response the way `str` formatting would.
    altitude = _to_float(gps_ifd.get(6))
    if altitude is not None:
        # GPSAltitudeRef 1 means "below sea level"; 0 means "above". Anything
        # else is not a sign, so the value is reported unsign-corrected.
        ref = _gps_byte_ref(gps_ifd.get(5))
        out["altitude"] = -altitude if ref == 1.0 else altitude
    else:
        out["altitude"] = None
    return out


def _find_serial(mapping: dict[Any, Any]) -> str | None:
    for tag_id in _SERIAL_TAGS:
        if tag_id in mapping:
            text = _stringify(mapping[tag_id])
            if text:
                return text
    return None


def _note(
    *,
    mismatch: bool,
    extension: str,
    detected: str | None,
    has_gps: bool,
    include_gps: bool,
    has_serial: bool,
    include_serials: bool,
    maker_note: bool,
    truncated: bool,
    dropped: int,
) -> str:
    parts = ["Type detected from the file's own bytes, never from its name."]
    if mismatch:
        named = _EXT_TO_FORMAT.get(extension, extension.upper() or "unknown")
        parts.append(f"Name says .{extension} ({named}) but the bytes are {detected}.")
    if truncated:
        parts.append(
            f"{dropped} further tag(s) were dropped at the {MAX_TAGS}-tag cap."
        )
    if has_gps and not include_gps:
        parts.append(_GPS_WITHHELD_REASON)
    if has_serial and not include_serials:
        parts.append(_SERIAL_WITHHELD_REASON)
    if maker_note:
        parts.append(
            "A maker note is present and was NOT decoded: vendor serials and "
            "location may be inside it."
        )
    parts.append(_COVERAGE_NOTE)
    return _clip(" ".join(parts), MAX_NOTE_CHARS)


def extract(
    data: bytes,
    *,
    filename: str | None = None,
    include_gps: bool = False,
    include_serials: bool = False,
) -> dict[str, Any]:
    """Parse EXIF out of image bytes already held in memory.

    Args:
        data: the raw upload. `bytes`, `bytearray` or `memoryview`.
        filename: DISPLAY ONLY. It is echoed back truncated and used to compute
            `extension_mismatch`. It never influences whether the upload is
            accepted and never influences `detected_type` — that comes from
            Pillow sniffing the bytes. Passing a `.jpg` name on GIF bytes
            yields `detected_type: "GIF"` and `extension_mismatch: True`.
        include_gps: opt in to returning coordinates. Default False reports
            `has_gps: True` with `gps: None` — presence without the value, so
            the user is never told a geotagged photo is clean. See the module
            docstring.
        include_serials: opt in to returning device serial numbers. Same
            presence-without-value default as `include_gps`.

    Returns:
        A JSON-serialisable dict. On success `ok` is True and `rejected_reason`
        is None; on any rejection `ok` is False with a user-facing
        `rejected_reason`, and every other key is present but empty. Never
        raises for hostile input — see the module docstring's error contract.

    Raises:
        TypeError: `data` is not bytes-like, or `filename` is not `str`/`None`.
            Those are caller bugs, not attacks.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError(f"data must be bytes-like, got {type(data).__name__}")
    if filename is not None and not isinstance(filename, str):
        raise TypeError(
            f"filename must be a string or None, got {type(filename).__name__}"
        )
    raw = bytes(data)

    result = _blank_result(filename)
    extension = _declared_extension(filename)

    # --- 1. size cap, before any decode ------------------------------------
    if len(raw) > MAX_INPUT_BYTES:
        return _reject(
            result,
            f"Rejected: upload is {len(raw):,} bytes, over the "
            f"{MAX_INPUT_BYTES:,}-byte ({MAX_INPUT_BYTES // (1024 * 1024)} MiB) cap.",
        )
    if not raw:
        return _reject(result, "Rejected: upload is empty.")

    # --- 2. content-based sniffing -----------------------------------------
    container = _sniff_non_image(raw)
    if container is not None:
        return _reject(
            result,
            f"Rejected on content: these bytes are a {container}, not a "
            "supported image, whatever the file is named.",
        )

    try:
        full, detected, width, height, mode = _open_verified(raw)
    except _Reject as reject:
        return _reject(result, str(reject))

    result["detected_type"] = detected
    result["width"] = width
    result["height"] = height
    result["pixel_count"] = width * height
    result["mode"] = _clip(mode, MAX_NAME_CHARS)

    named_format = _EXT_TO_FORMAT.get(extension)
    result["extension_mismatch"] = bool(
        extension and named_format is not None and named_format != detected
    )

    # --- 3. full decode, then metadata -------------------------------------
    try:
        with full:
            exif = full.getexif()
            # Forces the pixel decode, which is what actually catches a
            # truncated body that still carries a valid header.
            full.load()
    except (
        OSError,
        ValueError,
        SyntaxError,
        Image.DecompressionBombError,
        MemoryError,
    ) as exc:
        return _reject(result, f"The image could not be decoded ({exc}).")

    gps_ifd = _read_ifd(exif, ExifTags.IFD.GPSInfo)
    has_gps = 34853 in dict(exif) or bool(gps_ifd)

    serial_sources = (
        dict(exif),
        _read_ifd(exif, ExifTags.IFD.Exif),
        _read_ifd(exif, ExifTags.IFD.Interop),
        _read_ifd(exif, ExifTags.IFD.IFD1),
    )
    device_serial = next(
        (found for found in map(_find_serial, serial_sources) if found), None
    )

    try:
        tags, truncated, has_maker_note, tags_seen = _build_tags(
            exif, include_gps=include_gps, include_serials=include_serials
        )
    except (OSError, ValueError, TypeError, KeyError, SyntaxError, IndexError) as exc:
        return _reject(result, f"The EXIF block could not be read ({exc}).")

    result.update(
        {
            "ok": True,
            "has_exif": bool(dict(exif)),
            "has_maker_note": has_maker_note,
            "tags": tags,
            "tag_count": len(tags),
            "truncated": truncated,
            "has_gps": has_gps,
            "gps": _build_gps(gps_ifd) if (has_gps and include_gps) else None,
            "gps_withheld_reason": (
                _GPS_WITHHELD_REASON if (has_gps and not include_gps) else None
            ),
            "has_device_serial": device_serial is not None,
            "device_serial": device_serial if include_serials else None,
            "device_serial_withheld_reason": (
                _SERIAL_WITHHELD_REASON
                if (device_serial is not None and not include_serials)
                else None
            ),
            "note": _note(
                mismatch=result["extension_mismatch"],
                extension=extension,
                detected=detected,
                has_gps=has_gps,
                include_gps=include_gps,
                has_serial=device_serial is not None,
                include_serials=include_serials,
                maker_note=has_maker_note,
                truncated=truncated,
                dropped=max(0, tags_seen - len(tags)),
            ),
        }
    )
    return result


def strip_for_store(result: dict[str, Any]) -> dict[str, Any]:
    """Return a copy safe to persist, per AGENTS.md §7's audit minimum.

    Implements the TODO's "stripping on store" half: GPS coordinates and
    device serials are removed, their PRESENCE retained, so a stored row can
    still say "this photo was geotagged" without holding the coordinate.
    Also drops the withheld-value strings in favour of the short markers, and
    is idempotent — running it twice is the same as running it once.

    Redaction inside `tags` is by tag NAME, not by matching the withheld
    marker. A payload produced with `include_serials=True` carries the real
    serial in `tags` too, and matching the marker would strip exactly the
    payloads that need stripping least and leak exactly the ones that matter.

    Deliberately not applied inside `extract()`: stripping there would make
    the API dishonest (the user could never opt in), and a caller that
    persists the render-only payload still needs this before it writes.
    """
    serial_names = set(_SERIAL_TAGS.values())
    drop_gps_rows = bool(result.get("has_gps"))
    drop_serial_rows = bool(result.get("has_device_serial"))

    tags: list[dict[str, str]] = []
    for tag in result.get("tags", []):
        # GPS coordinates also live in the flat tag list when the caller opted
        # in, so those rows have to go too or the strip is cosmetic.
        if drop_gps_rows and tag.get("ifd") == "GPS":
            continue
        if drop_serial_rows and tag.get("name") in serial_names:
            value = "[withheld: device serial]"
        else:
            value = tag["value"]
        tags.append({"name": tag["name"], "value": value, "ifd": tag["ifd"]})

    stored = dict(result)
    stored["tags"] = tags
    if drop_gps_rows:
        stored["gps"] = None
        stored["gps_withheld_reason"] = "stripped before storage"
    if drop_serial_rows:
        stored["device_serial"] = None
        stored["device_serial_withheld_reason"] = "stripped before storage"
    stored["stored_stripped"] = True
    return stored
