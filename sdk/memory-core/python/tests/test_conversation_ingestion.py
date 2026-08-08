from __future__ import annotations

import httpx
import pytest

from tencentdb_agent_memory.errors import TDAMError, TDAMResponseError, TDAMTransportError
from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.v3.client import AsyncMemoryClient, MemoryClient


class Stub:
    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    def post(self, path: str, body: dict, timeout: float | None = None) -> dict:
        self.calls.append((path, body))
        return self.response

    def close(self) -> None:
        pass


class AsyncStub:
    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    async def post(self, path: str, body: dict, timeout: float | None = None) -> dict:
        self.calls.append((path, body))
        return self.response


def receipt_data() -> dict:
    return {
        "accepted_ids": ["msg-stable"],
        "accepted_versions": ["v1"],
        "total_count": 1,
        "receipt": {
            "source_event_id": "event-1",
            "content_hash": "hash-1",
            "status": "committed",
            "committed_at": "2026-08-08T00:00:00.000Z",
        },
    }


def test_sync_client_sends_source_identity_and_returns_receipt() -> None:
    stub = Stub(receipt_data())
    client = MemoryClient(
        endpoint="http://memory-core.test",
        api_key="key",
        service_id="memory-1",
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        session_id="session-1",
        stub=stub,
    )

    result = client.add_conversation(
        [{"role": "user", "content": "hello"}],
        source_event_id="event-1",
        content_hash="hash-1",
    )

    assert stub.calls[0][1]["source_event_id"] == "event-1"
    assert result["receipt"]["status"] == "committed"


def test_sync_client_preserves_legacy_omission_of_source_identity() -> None:
    stub = Stub({
        "accepted_ids": ["msg-legacy"],
        "accepted_versions": ["v1"],
        "total_count": 1,
    })
    client = MemoryClient(
        endpoint="http://memory-core.test",
        api_key="key",
        service_id="memory-1",
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        session_id="session-1",
        stub=stub,
    )

    result = client.add_conversation([{"role": "user", "content": "legacy"}])

    assert "source_event_id" not in stub.calls[0][1]
    assert "content_hash" not in stub.calls[0][1]
    assert "receipt" not in result


@pytest.mark.asyncio
async def test_async_client_sends_source_identity_and_returns_receipt() -> None:
    stub = AsyncStub(receipt_data())
    client = AsyncMemoryClient(
        endpoint="http://memory-core.test",
        api_key="key",
        service_id="memory-1",
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        session_id="session-1",
        stub=stub,
    )

    result = await client.add_conversation(
        [{"role": "user", "content": "hello"}],
        source_event_id="event-1",
        content_hash="hash-1",
    )

    assert stub.calls[0][1]["content_hash"] == "hash-1"
    assert result["receipt"]["source_event_id"] == "event-1"


def test_client_rejects_malformed_receipt() -> None:
    client = MemoryClient(
        endpoint="http://memory-core.test",
        api_key="key",
        service_id="memory-1",
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        session_id="session-1",
        stub=Stub({}),
    )

    with pytest.raises(TDAMResponseError):
        client.add_conversation(
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
        )


def test_http_stub_wraps_network_failures() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection lost", request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(fail))
    stub = HttpStub("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.retryable is True


@pytest.mark.parametrize("status", [408, 429, 503])
def test_http_stub_classifies_retryable_http_failures(status: int) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            request=request,
            json={"code": status, "message": "temporarily unavailable"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = HttpStub("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.code == status
    assert caught.value.retryable is True


@pytest.mark.parametrize("status,retryable", [(400, False), (503, True)])
def test_http_stub_classifies_non_json_failure_by_status(
    status: int,
    retryable: bool,
) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, request=request, text="plain-text failure")

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = HttpStub("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert not isinstance(caught.value, TDAMResponseError)
    assert caught.value.code == status
    assert caught.value.retryable is retryable


def test_http_stub_classifies_permanent_envelope_failure() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={"code": 40901, "message": "source event conflict"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = HttpStub("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.code == 40901
    assert caught.value.retryable is False


@pytest.mark.asyncio
async def test_async_http_stub_wraps_network_failures() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection lost", request=request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    stub = AsyncHttpStub("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        await stub.post("/v3/conversation/add", {})

    assert caught.value.retryable is True
    await stub.close()
