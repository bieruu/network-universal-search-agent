"""CPE identifier normalization: accept CPE 2.2 URIs, emit CPE 2.3.

Deterministic 1-to-1 mapping, never keyword guessing:
  cpe:/a:vendor:product:version:update:edition:language
    -> cpe:2.3:a:vendor:product:version:update:edition:language:*:*:*:*
Missing/empty 2.2 segments become "*" (any), matching the 2.3 wildcard.
"""

from __future__ import annotations

from typing import Any

_MAX_LEN = 300


def normalize_cpe(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()[:_MAX_LEN]
    if text.startswith("cpe:2.3:"):
        # cpe:2.3:part:vendor:product:... -> at least 5 colon parts.
        if len(text.split(":")) < 5:
            return None
        return text
    if text.startswith("cpe:/"):
        body = text[len("cpe:/") :]
        parts = body.split(":")
        # Need at least part + vendor + product for a meaningful product CPE.
        if len(parts) < 3 or parts[0].lower() not in ("a", "o", "h"):
            return None
        # part, vendor, product, version, update, edition, language -> 7 slots.
        slots = [p.strip() or "*" for p in parts[:7]]
        while len(slots) < 7:
            slots.append("*")
        slots[0] = slots[0].lower()
        fields = slots + ["*", "*", "*", "*"]
        return "cpe:2.3:" + ":".join(fields)
    return None
