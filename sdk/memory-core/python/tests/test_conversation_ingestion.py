from __future__ import annotations

import httpx
import pytest

from tencentdb_agent_memory.errors import TDAMError, TDAMResponseError, TDAMTransportError
from tencentdb_agent_memory._http import AsyncHttpStub as V2AsyncHttpStub
from tencentdb_agent_memory._http import HttpStub as V2HttpStub
from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.v2.client import AsyncMemoryClient as V2AsyncMemoryClient
from tencentdb_agent_memory.v2.client import MemoryClient as V2MemoryClient
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


def test_v2_sync_client_sends_optional_source_identity_and_returns_receipt() -> None:
    stub = Stub(receipt_data())
    client = V2MemoryClient(stub=stub)

    result = client.add_conversation(
        "session-1",
        [{"role": "user", "content": "hello"}],
        source_event_id="event-1",
        content_hash="hash-1",
    )

    assert stub.calls == [("/v2/conversation/add", {
        "session_id": "session-1",
        "source_event_id": "event-1",
        "content_hash": "hash-1",
        "messages": [{"role": "user", "content": "hello"}],
    })]
    assert result["receipt"]["status"] == "committed"


def test_v2_sync_client_preserves_legacy_source_identity_omission() -> None:
    stub = Stub({
        "accepted_ids": ["msg-legacy"],
        "accepted_versions": ["v1"],
        "total_count": 1,
    })
    client = V2MemoryClient(stub=stub)

    result = client.add_conversation(
        "session-1",
        [{"role": "user", "content": "legacy"}],
    )

    assert "source_event_id" not in stub.calls[0][1]
    assert "content_hash" not in stub.calls[0][1]
    assert "receipt" not in result


@pytest.mark.asyncio
async def test_v2_async_client_sends_optional_source_identity_and_returns_receipt() -> None:
    stub = AsyncStub(receipt_data())
    client = V2AsyncMemoryClient(stub=stub)

    result = await client.add_conversation(
        "session-1",
        [{"role": "user", "content": "hello"}],
        source_event_id="event-1",
        content_hash="hash-1",
    )

    assert stub.calls[0][1]["source_event_id"] == "event-1"
    assert result["receipt"]["source_event_id"] == "event-1"


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


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["v2", "v3"])
async def test_async_v2_and_v3_clients_preserve_legacy_source_identity_omission(
    client_kind: str,
) -> None:
    stub = AsyncStub({
        "accepted_ids": ["msg-legacy"],
        "accepted_versions": ["v1"],
        "total_count": 1,
    })
    if client_kind == "v2":
        client = V2AsyncMemoryClient(stub=stub)
        result = await client.add_conversation(
            "session-1",
            [{"role": "user", "content": "legacy"}],
        )
    else:
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
            [{"role": "user", "content": "legacy"}],
        )

    assert "source_event_id" not in stub.calls[0][1]
    assert "content_hash" not in stub.calls[0][1]
    assert "receipt" not in result


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


@pytest.mark.parametrize("client_cls", [V2MemoryClient, MemoryClient], ids=["v2", "v3"])
def test_sync_clients_reject_mismatched_success_counts(client_cls: type) -> None:
    response = {
        "accepted_ids": ["msg-1"],
        "accepted_versions": [],
        "total_count": 2,
        "receipt": receipt_data()["receipt"],
    }
    if client_cls is V2MemoryClient:
        client = client_cls(stub=Stub(response))
        call = lambda: client.add_conversation(
            "session-1",
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
            content_hash="hash-1",
        )
    else:
        client = client_cls(
            endpoint="http://memory-core.test",
            api_key="key",
            service_id="memory-1",
            team_id="team-1",
            agent_id="agent-1",
            user_id="user-1",
            session_id="session-1",
            stub=Stub(response),
        )
        call = lambda: client.add_conversation(
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
            content_hash="hash-1",
        )

    with pytest.raises(TDAMResponseError):
        call()


def test_v3_client_rejects_mismatched_receipt_content_hash() -> None:
    response = receipt_data()
    response["receipt"]["content_hash"] = "different-hash"
    client = MemoryClient(
        endpoint="http://memory-core.test",
        api_key="key",
        service_id="memory-1",
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        session_id="session-1",
        stub=Stub(response),
    )

    with pytest.raises(TDAMResponseError):
        client.add_conversation(
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
            content_hash="expected-hash",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["v2", "v3"])
async def test_async_v2_and_v3_clients_reject_mismatched_success_counts(
    client_kind: str,
) -> None:
    response = {
        "accepted_ids": ["msg-1"],
        "accepted_versions": [],
        "total_count": 2,
        "receipt": receipt_data()["receipt"],
    }
    stub = AsyncStub(response)
    if client_kind == "v2":
        client = V2AsyncMemoryClient(stub=stub)
        call = client.add_conversation(
            "session-1",
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
            content_hash="hash-1",
        )
    else:
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
        call = client.add_conversation(
            [{"role": "user", "content": "hello"}],
            source_event_id="event-1",
            content_hash="hash-1",
        )

    with pytest.raises(TDAMResponseError):
        await call


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
def test_sync_v2_and_v3_http_stubs_wrap_network_failures(stub_cls: type) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection lost", request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(fail))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.retryable is True


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
def test_sync_v2_and_v3_http_stubs_classify_timeouts(stub_cls: type) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(fail))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        stub.post("/conversation/add", {})

    assert caught.value.kind == "timeout"
    assert caught.value.retryable is True


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
@pytest.mark.parametrize("status", [408, 429, 500, 503, 599])
def test_sync_v2_and_v3_http_stubs_classify_retryable_http_failures(
    stub_cls: type,
    status: int,
) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            request=request,
            json={"code": status, "message": "temporarily unavailable"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.code == status
    assert caught.value.retryable is True


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
@pytest.mark.parametrize("status,retryable", [(400, False), (503, True)])
def test_sync_v2_and_v3_http_stubs_classify_non_json_failure_by_status(
    stub_cls: type,
    status: int,
    retryable: bool,
) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, request=request, text="plain-text failure")

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert not isinstance(caught.value, TDAMResponseError)
    assert caught.value.code == status
    assert caught.value.retryable is retryable


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
def test_sync_v2_and_v3_http_stubs_classify_permanent_envelope_failure(stub_cls: type) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={"code": 40901, "message": "source event conflict"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        stub.post("/v3/conversation/add", {})

    assert caught.value.code == 40901
    assert caught.value.retryable is False


@pytest.mark.parametrize("stub_cls", [V2HttpStub, HttpStub], ids=["v2", "v3"])
def test_sync_v2_and_v3_http_stubs_reject_malformed_success_envelopes(stub_cls: type) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"data": {}})

    http_client = httpx.Client(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMResponseError):
        stub.post("/conversation/add", {})


@pytest.mark.asyncio
@pytest.mark.parametrize("stub_cls", [V2AsyncHttpStub, AsyncHttpStub], ids=["v2", "v3"])
async def test_async_v2_and_v3_http_stubs_wrap_network_failures(stub_cls: type) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection lost", request=request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        await stub.post("/v3/conversation/add", {})

    assert caught.value.retryable is True
    await stub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stub_cls", [V2AsyncHttpStub, AsyncHttpStub], ids=["v2", "v3"])
async def test_async_v2_and_v3_http_stubs_classify_timeouts(stub_cls: type) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMTransportError) as caught:
        await stub.post("/conversation/add", {})

    assert caught.value.kind == "timeout"
    assert caught.value.retryable is True
    await stub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stub_cls", [V2AsyncHttpStub, AsyncHttpStub], ids=["v2", "v3"])
@pytest.mark.parametrize("status,retryable", [(400, False), (408, True), (429, True), (500, True), (599, True)])
async def test_async_v2_and_v3_http_stubs_classify_http_failures(
    stub_cls: type,
    status: int,
    retryable: bool,
) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            request=request,
            json={"code": status, "message": "write failed"},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        await stub.post("/conversation/add", {})

    assert caught.value.code == status
    assert caught.value.retryable is retryable
    await stub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stub_cls", [V2AsyncHttpStub, AsyncHttpStub], ids=["v2", "v3"])
async def test_async_v2_and_v3_http_stubs_classify_permanent_envelope_failures(stub_cls: type) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={"code": 40901, "message": "source event conflict"},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMError) as caught:
        await stub.post("/conversation/add", {})

    assert caught.value.code == 40901
    assert caught.value.retryable is False
    await stub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("stub_cls", [V2AsyncHttpStub, AsyncHttpStub], ids=["v2", "v3"])
async def test_async_v2_and_v3_http_stubs_reject_malformed_success_envelopes(stub_cls: type) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"data": {}})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    stub = stub_cls("http://memory-core.test", "key", "memory-1", client=http_client)

    with pytest.raises(TDAMResponseError):
        await stub.post("/conversation/add", {})

    await stub.close()
