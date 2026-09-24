import secrets
import logging
from datetime import timedelta
from django.utils import timezone
from django.contrib.auth.hashers import make_password, check_password
from django.conf import settings
from .models import OTPRecord

logger = logging.getLogger(__name__)

class BaseOTPProvider:
    """Base interface for SMS / OTP delivery."""
    def send_otp(self, phone: str, otp: str, purpose: str) -> bool:
        raise NotImplementedError


class DevelopmentOTPProvider(BaseOTPProvider):
    """
    Development OTP provider for local testing.
    Outputs OTP to console/logger and allows local verification without real SMS charges.
    Can easily be swapped with Twilio, AWS SNS, Msg91, etc. in production.
    """
    def send_otp(self, phone: str, otp: str, purpose: str) -> bool:
        logger.info(f"[DEV OTP PROVIDER] Phone: {phone} | OTP: {otp} | Purpose: {purpose}")
        print(f"\n==================================================")
        print(f" [DEV SMS] OTP for {phone}: {otp} ({purpose})")
        print(f"==================================================\n")
        return True


# Default provider instance (swappable via configuration)
_otp_provider = DevelopmentOTPProvider()

def set_otp_provider(provider: BaseOTPProvider):
    global _otp_provider
    _otp_provider = provider

def get_otp_provider() -> BaseOTPProvider:
    return _otp_provider


class OTPService:
    OTP_EXPIRY_SECONDS = 300   # 5 minutes
    MAX_ATTEMPTS = 5           # Max invalid attempts before invalidating
    COOLDOWN_SECONDS = 30      # Cooldown between OTP requests
    MAX_HOURLY_REQUESTS = 6    # Max requests per hour per phone

    @staticmethod
    def normalize_phone(phone: str) -> str:
        """Strip formatting and normalize phone number."""
        if not phone:
            return ""
        clean = "".join(ch for ch in str(phone) if ch.isdigit() or ch == '+')
        # If 10 digits without country code, prefix with +91 (standard Indian format)
        if len(clean) == 10 and clean.isdigit():
            clean = "+91" + clean
        elif clean.startswith("91") and len(clean) == 12:
            clean = "+" + clean
        return clean

    @classmethod
    def can_request_otp(cls, phone: str):
        """Check rate limiting and cooldown for requesting an OTP."""
        normalized = cls.normalize_phone(phone)
        now = timezone.now()

        # Check cooldown from last request
        recent = OTPRecord.objects.filter(phone=normalized).order_by('-created_at').first()
        if recent:
            elapsed = (now - recent.created_at).total_seconds()
            if elapsed < cls.COOLDOWN_SECONDS:
                remaining = int(cls.COOLDOWN_SECONDS - elapsed)
                return False, f"Please wait {remaining} seconds before requesting a new OTP."

        # Check hourly rate limit
        one_hour_ago = now - timedelta(hours=1)
        count_last_hour = OTPRecord.objects.filter(phone=normalized, created_at__gte=one_hour_ago).count()
        if count_last_hour >= cls.MAX_HOURLY_REQUESTS:
            return False, "Too many OTP requests. Please try again after some time."

        return True, None

    @classmethod
    def generate_and_send_otp(cls, phone: str, purpose: str = 'auth'):
        """
        Generates a cryptographically secure 6-digit OTP, stores its hash,
        and dispatches it via the configured provider.
        """
        normalized = cls.normalize_phone(phone)
        if not normalized or len(normalized) < 10:
            return False, None, "Please provide a valid 10-digit mobile number."

        can_send, err_msg = cls.can_request_otp(normalized)
        if not can_send:
            return False, None, err_msg

        # Generate secure 6-digit random OTP
        # secrets.randbelow(900000) generates 0..899999, + 100000 gives 100000..999999
        otp_code = str(secrets.randbelow(900000) + 100000)
        otp_hash = make_password(otp_code)

        # Invalidate previous unused OTPs for this phone & purpose
        OTPRecord.objects.filter(
            phone=normalized,
            purpose=purpose,
            is_used=False
        ).update(is_used=True)

        now = timezone.now()
        expires_at = now + timedelta(seconds=cls.OTP_EXPIRY_SECONDS)

        # Record OTP in database
        OTPRecord.objects.create(
            phone=normalized,
            otp_hash=otp_hash,
            purpose=purpose,
            expires_at=expires_at,
            attempts=0,
            is_used=False
        )

        # Send via provider
        provider = get_otp_provider()
        provider.send_otp(normalized, otp_code, purpose)

        return True, otp_code, None

    @classmethod
    def verify_otp(cls, phone: str, otp_input: str, purpose: str = 'auth'):
        """
        Verifies the user-entered OTP. Single-use and attempt-limited.
        """
        normalized = cls.normalize_phone(phone)
        if not normalized or not otp_input:
            return False, "Mobile number and OTP are required."

        now = timezone.now()
        record = OTPRecord.objects.filter(
            phone=normalized,
            purpose=purpose,
            is_used=False
        ).order_by('-created_at').first()

        if not record:
            return False, "No active OTP request found. Please request a new OTP."

        if now > record.expires_at:
            record.is_used = True
            record.save()
            return False, "OTP has expired. Please request a new one."

        if record.attempts >= cls.MAX_ATTEMPTS:
            record.is_used = True
            record.save()
            return False, "Too many failed attempts. This OTP has been invalidated. Please request a new one."

        # Verify password/hash
        is_valid = check_password(otp_input.strip(), record.otp_hash)

        if not is_valid:
            record.attempts += 1
            record.save()
            remaining = cls.MAX_ATTEMPTS - record.attempts
            if remaining <= 0:
                record.is_used = True
                record.save()
                return False, "Invalid OTP. Maximum attempts exceeded. Please request a new OTP."
            return False, f"Invalid OTP. {remaining} attempt{'s' if remaining != 1 else ''} remaining."

        # Mark as used (single-use enforcement)
        record.is_used = True
        record.save()
        return True, "OTP verified successfully."
