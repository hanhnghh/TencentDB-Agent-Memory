import asyncio

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub, _decode_response
from tencentdb_agent_memory.errors import TDAMError
from tencentdb_agent_memory.v3.skill_client import AsyncSkillClient, SkillClient


class Stub:
    def __init__(self):
        self.body = None

    def post(self, _path, body, timeout=None):
        self.body = body
        return {
            "status": "ok",
            "receipt": {
                "receipt_id": "receipt-1",
                "source_event_id": "event-1",
                "content_hash": "sha256:abc",
                "accepted_at_ms": 42,
            },
        }


class AsyncStub(Stub):
    async def post(self, path, body, timeout=None):
        return super().post(path, body, timeout)


REQUEST = {
    "session_id": "session-1",
    "user_id": "user-1",
    "team_id": "team-1",
    "agent_id": "agent-1",
    "source_event_id": "event-1",
    "content_hash": "sha256:abc",
    "messages": [{"role": "user", "content": "hello"}],
}


def test_sync_and_async_clients_expose_receipt_and_send_event_identity():
    sync_stub = Stub()
    sync_result = SkillClient(stub=sync_stub).conversation_add(**REQUEST)
    assert sync_stub.body["source_event_id"] == "event-1"
    assert sync_result["receipt"]["receipt_id"] == "receipt-1"

    async_stub = AsyncStub()
    async_result = asyncio.run(AsyncSkillClient(stub=async_stub).conversation_add(**REQUEST))
    assert async_stub.body["content_hash"] == "sha256:abc"
    assert async_result["receipt"]["receipt_id"] == "receipt-1"


@pytest.mark.parametrize(
    ("status", "code", "retryable", "kind"),
    [
        (400, 40001, False, "client"),
        (408, 40001, True, "timeout"),
        (409, 40902, False, "conflict"),
        (429, 4291, True, "rate_limit"),
        (503, 50001, True, "server"),
    ],
)
def test_transport_exposes_typed_retry_classification(status, code, retryable, kind):
    response = httpx.Response(
        status,
        json={"code": code, "message": "failed", "request_id": "request-1"},
    )
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.retryable is retryable
    assert caught.value.kind == kind
    assert caught.value.http_status == status


@pytest.mark.parametrize(
    ("code", "retryable", "kind"),
    [
        (40902, False, "conflict"),
        (50001, True, "server"),
    ],
)
def test_http_200_business_failures_remain_typed(code, retryable, kind):
    response = httpx.Response(
        200,
        json={"code": code, "message": "failed", "request_id": "request-business"},
    )
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.code == code
    assert caught.value.retryable is retryable
    assert caught.value.kind == kind
    assert caught.value.request_id == "request-business"


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (
            httpx.ConnectError(
                "socket unavailable",
                request=httpx.Request("POST", "https://core.example"),
            ),
            "network",
        ),
        (
            httpx.ReadTimeout(
                "deadline exceeded",
                request=httpx.Request("POST", "https://core.example"),
            ),
            "timeout",
        ),
    ],
)
def test_sync_transport_exposes_network_and_timeout_failures(error, kind):
    class FailingClient:
        timeout = 1

        def post(self, **_kwargs):
            raise error

    transport = HttpStub(
        "https://core.example",
        "key",
        "space-1",
        client=FailingClient(),
    )
    with pytest.raises(TDAMError) as caught:
        transport.post("/v3/skill/conversation/add", REQUEST)
    assert caught.value.kind == kind
    assert caught.value.retryable is True


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (
            httpx.ConnectError(
                "socket unavailable",
                request=httpx.Request("POST", "https://core.example"),
            ),
            "network",
        ),
        (
            httpx.ReadTimeout(
                "deadline exceeded",
                request=httpx.Request("POST", "https://core.example"),
            ),
            "timeout",
        ),
    ],
)
def test_async_transport_exposes_network_and_timeout_failures(error, kind):
    class FailingAsyncClient:
        timeout = 1

        async def post(self, **_kwargs):
            raise error

    transport = AsyncHttpStub(
        "https://core.example",
        "key",
        "space-1",
        client=FailingAsyncClient(),
    )

    async def invoke():
        await transport.post("/v3/skill/conversation/add", REQUEST)

    with pytest.raises(TDAMError) as caught:
        asyncio.run(invoke())
    assert caught.value.kind == kind
    assert caught.value.retryable is True


def test_malformed_success_is_a_typed_permanent_failure():
    response = httpx.Response(200, content=b"secret-response-body")
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.kind == "invalid_response"
    assert caught.value.retryable is False
    assert "secret-response-body" not in str(caught.value)


def test_non_object_success_data_is_a_typed_permanent_failure():
    response = httpx.Response(200, json={"code": 0, "data": []})
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.kind == "invalid_response"
    assert caught.value.retryable is False


def test_non_object_response_envelope_is_a_typed_permanent_failure():
    response = httpx.Response(200, json=[])
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.kind == "invalid_response"
    assert caught.value.retryable is False


@pytest.mark.parametrize("client_cls", [SkillClient, AsyncSkillClient])
def test_conversation_add_rejects_success_without_a_durable_receipt(client_cls):
    class MalformedStub(Stub):
        def post(self, _path, body, timeout=None):
            return {"status": "ok"}

    if client_cls is AsyncSkillClient:
        class MalformedAsyncStub(MalformedStub):
            async def post(self, path, body, timeout=None):
                return super().post(path, body, timeout)

        call = client_cls(stub=MalformedAsyncStub()).conversation_add(**REQUEST)
        invoke = lambda: asyncio.run(call)
    else:
        invoke = lambda: client_cls(stub=MalformedStub()).conversation_add(**REQUEST)

    with pytest.raises(TDAMError) as caught:
        invoke()
    assert caught.value.kind == "invalid_response"
    assert caught.value.retryable is False
