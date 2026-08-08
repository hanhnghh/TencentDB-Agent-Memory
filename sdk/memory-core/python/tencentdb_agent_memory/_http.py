"""Low-level HTTP transport for the TencentDB Agent Memory v2 API.

Provides Bearer-token authentication, response-envelope unwrapping
(``code == 0`` → ``data``; otherwise raise ``TDAMError``), and trace-id
propagation via the ``x-trace-id`` response header.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Protocol

import httpx

from .errors import TDAMError, TDAMResponseError, TDAMTransportError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stub abstraction
# ---------------------------------------------------------------------------

class Stub(ABC):
    """Base transport interface."""

    @abstractmethod
    def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        ...

    @abstractmethod
    def close(self) -> None:
        ...


class AsyncStub(Protocol):
    """Structural transport interface shared by asynchronous clients."""

    async def post(
        self,
        path: str,
        body: dict,
        timeout: Optional[float] = None,
    ) -> dict:
        ...

    async def close(self) -> None:
        ...


class HttpStub(Stub):
    """Synchronous HTTP transport backed by :mod:`httpx`.

    Parameters
    ----------
    endpoint : str
        Base URL of the memory service, e.g.
        ``https://memory.tencentyun.com``.
    api_key : str
        Bearer token sent via ``Authorization`` header.
    service_id : str
        Memory instance ID (sent via ``x-tdai-service-id`` header).
    timeout : float
        Default request timeout in seconds.
    user_key : str | None
        Optional user API key sent via ``x-tdai-user-key`` header
        (system_admin endpoints such as user/create need it).
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = False,
        user_key: Optional[str] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.client = client or httpx.Client(timeout=timeout, verify=verify)
        self.headers: Dict[str, str] = {
            "Authorization": f"Bearer {api_key}",
            "x-tdai-service-id": service_id,
            "Content-Type": "application/json",
        }
        if user_key:
            self.headers["x-tdai-user-key"] = user_key

    def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        url = f"{self.endpoint}{path}"
        logger.debug("Request POST %s", path)
        try:
            resp = self.client.post(
                url=url,
                json=body,
                headers=self.headers,
                timeout=timeout or self.client.timeout,
            )
        except httpx.TimeoutException as exc:
            raise TDAMTransportError("timeout", f"POST {path} timed out") from exc
        except httpx.RequestError as exc:
            raise TDAMTransportError("network", f"POST {path} network failure") from exc
        logger.debug("Response %s status=%s", path, resp.status_code)
        return _decode_response(resp)

    def close(self) -> None:
        if isinstance(self.client, httpx.Client):
            self.client.close()


# ---------------------------------------------------------------------------
# Async variant
# ---------------------------------------------------------------------------

class AsyncHttpStub:
    """Asynchronous HTTP transport backed by :mod:`httpx`."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = False,
        user_key: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.client = client or httpx.AsyncClient(timeout=timeout, verify=verify)
        self.headers: Dict[str, str] = {
            "Authorization": f"Bearer {api_key}",
            "x-tdai-service-id": service_id,
            "Content-Type": "application/json",
        }
        if user_key:
            self.headers["x-tdai-user-key"] = user_key

    async def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        url = f"{self.endpoint}{path}"
        logger.debug("Request POST %s", path)
        try:
            resp = await self.client.post(
                url=url,
                json=body,
                headers=self.headers,
                timeout=timeout or self.client.timeout,
            )
        except httpx.TimeoutException as exc:
            raise TDAMTransportError("timeout", f"POST {path} timed out") from exc
        except httpx.RequestError as exc:
            raise TDAMTransportError("network", f"POST {path} network failure") from exc
        logger.debug("Response %s status=%s", path, resp.status_code)
        return _decode_response(resp)

    async def close(self) -> None:
        if isinstance(self.client, httpx.AsyncClient):
            await self.client.aclose()


def _decode_response(resp: httpx.Response) -> dict:
    request_id = (
        resp.headers.get("x-qcloud-transaction-id")
        or resp.headers.get("x-trace-id")
        or ""
    )
    try:
        envelope = resp.json()
    except ValueError as exc:
        message = f"HTTP {resp.status_code} returned a non-JSON response"
        if resp.is_error:
            raise TDAMError(resp.status_code, message, request_id) from exc
        raise TDAMResponseError(message, request_id) from exc

    code = envelope.get("code") if isinstance(envelope, dict) else None
    if isinstance(code, bool) or not isinstance(code, int):
        raise TDAMResponseError(
            "API response envelope must be an object with a numeric code",
            request_id,
        )
    if resp.is_error or code != 0:
        effective_code = code if code != 0 else resp.status_code
        payload = envelope.get("data")
        details = payload if isinstance(payload, dict) else None
        raise TDAMError(
            code=effective_code,
            message=str(envelope.get("message") or f"HTTP {resp.status_code}"),
            request_id=str(envelope.get("request_id") or request_id),
            details=details,
        )
    result = envelope.get("data") or {}
    if not isinstance(result, dict):
        raise TDAMResponseError("API response data must be a JSON object", request_id)
    trace_id = resp.headers.get("x-trace-id")
    if trace_id:
        result["trace_id"] = trace_id
    return result
