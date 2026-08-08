"""TencentDB Agent Memory SDK error types."""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional


class TDAMError(Exception):
    """Raised when the API returns a non-zero business code.

    ``details`` carries any envelope ``data`` payload returned alongside the
    error — used by /v3/skill/* endpoints to hand back ``current_version``
    (40901 SKILL_VERSION_STALE) or ``latest_version`` (41002
    SKILL_VERSION_EXPIRED) so the caller can retry / upgrade cleanly.
    """

    def __init__(
        self,
        code: int,
        message: str,
        request_id: str = "",
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__()
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = dict(details) if details else None
        digits = str(abs(int(code)))
        normalized = int(digits[:3]) if len(digits) > 3 else code
        self.retryable = normalized in (408, 429) or normalized >= 500

    def __str__(self) -> str:
        if self.request_id:
            return (
                f"<TDAMError: (code={self.code}, "
                f"message={self.message}, request_id={self.request_id})>"
            )
        return f"<TDAMError: (code={self.code}, message={self.message})>"


class ParamError(Exception):
    """Raised when caller-supplied parameters are invalid."""


class TDAMTransportError(TDAMError):
    """Typed retryable network/timeout failure."""

    def __init__(self, kind: Literal["network", "timeout"], message: str) -> None:
        super().__init__(408 if kind == "timeout" else -1, message)
        self.kind = kind
        self.retryable = True


class TDAMResponseError(TDAMError):
    """Typed malformed-response failure."""

    def __init__(self, message: str, request_id: str = "") -> None:
        super().__init__(-1, message, request_id)
        self.kind = "malformed"
        self.retryable = True
