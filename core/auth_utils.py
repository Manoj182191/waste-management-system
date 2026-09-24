import secrets
from functools import wraps
from datetime import timedelta
from django.utils import timezone
from django.http import JsonResponse
from .models import AuthSession, UserAccount

SESSION_LIFETIME_DAYS = 30

def create_auth_session(user: UserAccount, days: int = SESSION_LIFETIME_DAYS) -> str:
    """Generate and persist a secure session token."""
    token = secrets.token_hex(32)
    expires_at = timezone.now() + timedelta(days=days)

    # Invalidate old sessions for this user if needed or keep multi-device
    AuthSession.objects.create(
        token=token,
        user=user,
        expires_at=expires_at,
        is_active=True
    )
    return token


def get_token_from_request(request) -> str:
    """Extract auth token from Authorization header or custom header."""
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    
    token = request.headers.get('X-Auth-Token', '')
    if token:
        return token.strip()

    # Fallback to GET or POST param if explicitly provided
    if request.method == 'GET':
        return request.GET.get('token', '').strip()
    return ''


def get_authenticated_user(request):
    """
    Validate the token from request and return (user, session).
    Returns (None, None) if missing, invalid, or expired.
    """
    token = get_token_from_request(request)
    if not token:
        return None, None

    now = timezone.now()
    session = AuthSession.objects.select_related('user').filter(
        token=token,
        is_active=True,
        expires_at__gt=now
    ).first()

    if not session or not session.user:
        return None, None

    return session.user, session


def revoke_auth_session(request) -> bool:
    """Invalidate current session on explicit logout."""
    token = get_token_from_request(request)
    if not token:
        return False
    updated = AuthSession.objects.filter(token=token).update(is_active=False)
    return updated > 0


def require_auth(allowed_roles=None, allow_pending=False):
    """
    Backend RBAC decorator.
    Enforces that:
    1. The user has a valid, active session token.
    2. The user has one of the allowed_roles (if specified).
    3. The user's account status is 'active' (unless allow_pending=True).
    """
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(request, *args, **kwargs):
            user, session = get_authenticated_user(request)

            if not user:
                return JsonResponse({
                    "error": "Authentication required. Please log in with your phone and OTP."
                }, status=401)

            # Check account status
            if not allow_pending and user.status != 'active':
                return JsonResponse({
                    "error": f"Account is {user.status}. Access denied.",
                    "status": user.status
                }, status=403)

            # Check role permissions
            if allowed_roles:
                roles = [r.lower() for r in allowed_roles]
                if user.role.lower() not in roles:
                    return JsonResponse({
                        "error": f"Access denied: this resource requires one of roles: {allowed_roles}.",
                        "user_role": user.role
                    }, status=403)

            request.user_account = user
            request.auth_session = session
            return view_func(request, *args, **kwargs)
        return wrapper
    return decorator
