"""Bounded Subfinder CLI adapter used when crt.sh is unavailable."""

from __future__ import annotations

import asyncio
import ipaddress
import re
import shutil
from typing import Any

TIMEOUT_SECONDS = 10
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_SUBDOMAINS = 500
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _normalize_domain(target: str) -> str:
    domain = target.rstrip(".").lower()
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise RuntimeError("Subfinder fallback requires a DNS domain")

    labels = domain.split(".")
    if (
        len(domain) > 253
        or len(labels) < 2
        or any(not _LABEL_RE.fullmatch(label) for label in labels)
    ):
        raise RuntimeError("Subfinder fallback requires a valid DNS domain")
    return domain


async def _read_bounded(stream: asyncio.StreamReader, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await stream.read(min(65536, limit - size + 1))
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > limit:
            raise RuntimeError("Subfinder output exceeded the 1 MiB limit")
        chunks.append(chunk)


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
        await process.wait()


def _normalize_output(output: bytes, domain: str) -> dict[str, Any]:
    seen: set[str] = set()
    subdomains: list[dict[str, str]] = []
    for line in output.decode("utf-8", errors="replace").splitlines():
        name = line.strip().lower().rstrip(".")
        name = name.removeprefix("*.")
        labels = name.split(".")
        if (
            not name
            or len(name) > 253
            or any(not _LABEL_RE.fullmatch(label) for label in labels)
            or (name != domain and not name.endswith(f".{domain}"))
            or name in seen
        ):
            continue
        seen.add(name)
        subdomains.append(
            {"subdomain": name, "issuer": "", "not_before": "", "not_after": ""}
        )
        if len(subdomains) >= MAX_SUBDOMAINS:
            break
    return {"domain": domain, "count": len(subdomains), "subdomains": subdomains}


async def lookup(target: str) -> dict[str, Any]:
    """Run Subfinder without a shell and bound time, captured output, and results."""
    domain = _normalize_domain(target)
    binary = shutil.which("subfinder")
    if binary is None:
        raise RuntimeError("Subfinder CLI is unavailable on PATH")

    try:
        process = await asyncio.create_subprocess_exec(
            binary,
            "-d",
            domain,
            "-silent",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except NotImplementedError as exc:
        raise RuntimeError(
            "Subfinder fallback is not available on this runtime; subprocess support is missing"
        ) from exc
    except OSError as exc:
        raise RuntimeError("Subfinder CLI could not be started") from exc

    if process.stdout is None:
        await _stop_process(process)
        raise RuntimeError("Subfinder CLI did not provide output")

    reader = asyncio.create_task(_read_bounded(process.stdout, MAX_OUTPUT_BYTES))
    waiter = asyncio.create_task(process.wait())
    try:
        output, _ = await asyncio.wait_for(
            asyncio.gather(reader, waiter), timeout=TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError as exc:
        await _stop_process(process)
        raise RuntimeError(f"Subfinder timed out after {TIMEOUT_SECONDS}s") from exc
    except BaseException:
        await _stop_process(process)
        raise
    finally:
        for task in (reader, waiter):
            if not task.done():
                task.cancel()
        await asyncio.gather(reader, waiter, return_exceptions=True)

    if process.returncode != 0:
        raise RuntimeError(f"Subfinder failed (exit code {process.returncode})")
    return _normalize_output(output, domain)
