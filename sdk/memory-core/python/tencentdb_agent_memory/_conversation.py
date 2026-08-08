"""Shared validation for the public L0 conversation write receipt."""

from datetime import datetime
from typing import Any, Dict, Optional

from .errors import TDAMResponseError


def _is_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def validate_conversation_add_result(
    data: Any,
    source_event_id: Optional[str],
    content_hash: Optional[str],
) -> Dict[str, Any]:
    """Validate the response shape shared by the v2 and v3 clients."""
    if not isinstance(data, dict):
        raise TDAMResponseError("conversation/add response data must be an object")
    accepted_ids = data.get("accepted_ids")
    accepted_versions = data.get("accepted_versions")
    total_count = data.get("total_count")
    if (
        not isinstance(accepted_ids, list)
        or not all(isinstance(item, str) for item in accepted_ids)
        or not isinstance(accepted_versions, list)
        or not all(isinstance(item, str) for item in accepted_versions)
        or len(accepted_versions) != len(accepted_ids)
        or isinstance(total_count, bool)
        or not isinstance(total_count, int)
        or total_count != len(accepted_ids)
    ):
        raise TDAMResponseError("conversation/add returned malformed receipt data")
    if source_event_id is not None:
        receipt = data.get("receipt")
        if (
            not isinstance(receipt, dict)
            or receipt.get("source_event_id") != source_event_id
            or not isinstance(receipt.get("content_hash"), str)
            or (content_hash is not None and receipt.get("content_hash") != content_hash)
            or receipt.get("status") not in ("committed", "duplicate")
            or not _is_timestamp(receipt.get("committed_at"))
        ):
            raise TDAMResponseError(
                "conversation/add returned a malformed or mismatched source-event receipt"
            )
    return data
