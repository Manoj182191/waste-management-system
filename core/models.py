from django.db import models
from django.contrib.auth.hashers import make_password, check_password

class UserAccount(models.Model):
    ROLE_CHOICES = (
        ('citizen', 'Citizen'),
        ('generator', 'Generator'),
        ('admin', 'Admin'),
        ('collector', 'Collector'), # Retained for existing waste collector tasks
    )
    STATUS_CHOICES = (
        ('active', 'Active'),
        ('pending', 'Pending'),
        ('rejected', 'Rejected'),
    )

    username = models.CharField(max_length=50, unique=True)
    password = models.CharField(max_length=255, blank=True, null=True) # Optional for OTP users (citizens, generators)
    name = models.CharField(max_length=100)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    phone = models.CharField(max_length=20, blank=True, null=True, db_index=True)
    email = models.CharField(max_length=100, blank=True, null=True)
    address = models.TextField(blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='active')

    def set_password(self, raw_password):
        if raw_password:
            self.password = make_password(raw_password)
        else:
            self.password = None

    def verify_password(self, raw_password):
        if not self.password:
            return False
        if self.password.startswith('pbkdf2_') or self.password.startswith('bcrypt') or self.password.startswith('argon2'):
            return check_password(raw_password, self.password)
        # Fallback to plain text comparison if plain text exists
        return self.password == raw_password

    def __str__(self):
        return f"{self.name} (@{self.username}) - {self.role} [{self.status}]"


class OTPRecord(models.Model):
    phone = models.CharField(max_length=20, db_index=True)
    otp_hash = models.CharField(max_length=255)
    purpose = models.CharField(max_length=30, default='auth') # auth, citizen_setup, generator_apply
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    attempts = models.IntegerField(default=0)
    is_used = models.BooleanField(default=False)

    def __str__(self):
        return f"OTP for {self.phone} ({self.purpose}) - used={self.is_used}"


class GeneratorApplication(models.Model):
    STATUS_CHOICES = (
        ('pending', 'Pending'),
        ('approved', 'Approved'),
        ('rejected', 'Rejected'),
    )

    user = models.ForeignKey(UserAccount, on_delete=models.CASCADE, related_name='generator_applications')
    business_name = models.CharField(max_length=150)
    applicant_name = models.CharField(max_length=100)
    phone = models.CharField(max_length=20)
    email = models.CharField(max_length=100, blank=True, null=True)
    address = models.TextField()
    id_type = models.CharField(max_length=50) # Trade License, GSTIN, Municipal Ward ID, etc.
    id_number = models.CharField(max_length=100)
    document_file = models.FileField(upload_to='generator_docs/', blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    rejection_reason = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.business_name} ({self.applicant_name}) - {self.status}"


class AuthSession(models.Model):
    token = models.CharField(max_length=64, unique=True, db_index=True)
    user = models.ForeignKey(UserAccount, on_delete=models.CASCADE, related_name='sessions')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f"Session for {self.user.username} - active={self.is_active}"


class WasteRequest(models.Model):
    PRIORITY_CHOICES = (
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
    )

    id = models.CharField(max_length=50, primary_key=True)
    type = models.CharField(max_length=100)
    location = models.CharField(max_length=255)
    status = models.CharField(max_length=50, default='pending')
    date = models.CharField(max_length=100) # ISO format string for simplicity
    citizen_name = models.CharField(max_length=100)
    collector = models.CharField(max_length=100, null=True, blank=True)
    priority = models.CharField(max_length=10, choices=PRIORITY_CHOICES, default='medium')
    notes = models.TextField(blank=True, null=True)  # Collector completion notes
    started_at = models.DateTimeField(null=True, blank=True)  # When collector started
    completed_at = models.DateTimeField(null=True, blank=True)  # When marked complete

    def __str__(self):
        return f"{self.type} at {self.location} - {self.status}"
