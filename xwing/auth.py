from fastapi import HTTPException, Request

from .config import Settings


def get_user(request: Request, settings: Settings) -> str:
    user = request.headers.get(settings.user_header)
    if user is None:
        if settings.require_auth:
            raise HTTPException(status_code=403, detail="Authentication required")
        return "anonymous"
    return user
