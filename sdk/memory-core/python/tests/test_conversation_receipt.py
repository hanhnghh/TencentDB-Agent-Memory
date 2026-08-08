import asyncio

import httpx
import pytest

from tencentdb_agent_memory._v3_http import _decode_response
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


def test_malformed_success_is_a_typed_permanent_failure():
    response = httpx.Response(200, content=b"not-json")
    with pytest.raises(TDAMError) as caught:
        _decode_response(response)
    assert caught.value.kind == "invalid_response"
    assert caught.value.retryable is False
