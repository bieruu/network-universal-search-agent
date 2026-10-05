from __future__ import annotations

import asyncio

import pytest

from app.services import subfinder_service


class _FakeProcess:
    def __init__(self, output: bytes = b"", returncode: int | None = 0, hang=False):
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(output)
        self.stdout.feed_eof()
        self.returncode = returncode
        self._hang = hang
        self._stopped = asyncio.Event()

    async def wait(self):
        if self._hang:
            await self._stopped.wait()
        return self.returncode

    def kill(self):
        self.returncode = -9
        self._stopped.set()


def _mock_process(monkeypatch, process):
    calls = []

    def which(binary):
        assert binary == "subfinder"
        return r"C:\tools\subfinder.exe"

    async def create_subprocess_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return process

    monkeypatch.setattr(subfinder_service.shutil, "which", which)
    monkeypatch.setattr(
        subfinder_service.asyncio, "create_subprocess_exec", create_subprocess_exec
    )
    return calls


@pytest.mark.asyncio
async def test_subfinder_normalizes_deduplicates_and_caps_output(monkeypatch):
    output = (
        b"WWW.Example.com.\n*.mail.example.com\nwww.example.com\n"
        b"outside.test\nnot a hostname\n"
        + b"".join(f"host{i}.example.com\n".encode() for i in range(510))
    )
    process = _FakeProcess(output=output)
    calls = _mock_process(monkeypatch, process)

    result = await subfinder_service.lookup("Example.com")

    assert result["domain"] == "example.com"
    assert result["count"] == 500
    names = [item["subdomain"] for item in result["subdomains"]]
    assert names[:2] == ["www.example.com", "mail.example.com"]
    assert len(names) == len(set(names)) == 500
    assert names[-1] == "host497.example.com"
    args, kwargs = calls[0]
    assert args == (r"C:\tools\subfinder.exe", "-d", "example.com", "-silent")
    assert kwargs["stdout"] == asyncio.subprocess.PIPE
    assert kwargs["stderr"] == asyncio.subprocess.DEVNULL
    assert "shell" not in kwargs


@pytest.mark.asyncio
async def test_subfinder_rejects_invalid_domain_before_launch(monkeypatch):
    def unexpected_lookup(_):
        pytest.fail("Binary lookup must not happen for an invalid domain")

    monkeypatch.setattr(subfinder_service.shutil, "which", unexpected_lookup)

    with pytest.raises(RuntimeError, match="valid DNS domain"):
        await subfinder_service.lookup("example.com; whoami")


@pytest.mark.asyncio
async def test_subfinder_missing_binary_is_reported(monkeypatch):
    monkeypatch.setattr(subfinder_service.shutil, "which", lambda _: None)

    with pytest.raises(RuntimeError, match="unavailable on PATH"):
        await subfinder_service.lookup("example.com")


@pytest.mark.asyncio
async def test_subfinder_not_implemented_runtime_error_is_reported(monkeypatch):
    monkeypatch.setattr(
        subfinder_service.shutil, "which", lambda _: r"C:\tools\subfinder.exe"
    )

    async def unsupported(*args, **kwargs):
        raise NotImplementedError("asyncio.subprocess is not supported")

    monkeypatch.setattr(
        subfinder_service.asyncio, "create_subprocess_exec", unsupported
    )

    with pytest.raises(
        RuntimeError,
        match="not available on this runtime|subprocess support is missing",
    ):
        await subfinder_service.lookup("example.com")


@pytest.mark.asyncio
async def test_subfinder_nonzero_exit_is_reported(monkeypatch):
    _mock_process(monkeypatch, _FakeProcess(output=b"www.example.com\n", returncode=2))

    with pytest.raises(RuntimeError, match="exit code 2"):
        await subfinder_service.lookup("example.com")


@pytest.mark.asyncio
async def test_subfinder_timeout_stops_process(monkeypatch):
    process = _FakeProcess(returncode=None, hang=True)
    _mock_process(monkeypatch, process)
    monkeypatch.setattr(subfinder_service, "TIMEOUT_SECONDS", 0.01)

    with pytest.raises(RuntimeError, match="timed out"):
        await subfinder_service.lookup("example.com")

    assert process.returncode == -9


@pytest.mark.asyncio
async def test_subfinder_output_over_limit_stops_capture(monkeypatch):
    process = _FakeProcess(
        output=b"x" * (subfinder_service.MAX_OUTPUT_BYTES + 1),
        returncode=None,
        hang=True,
    )
    _mock_process(monkeypatch, process)

    with pytest.raises(RuntimeError, match="1 MiB limit"):
        await subfinder_service.lookup("example.com")

    assert process.returncode == -9
