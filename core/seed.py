from .models import UserAccount

def seed_admin():
    """Create the default system administrator account.
    Every real-world system needs a bootstrap admin created during setup.
    """
    user, created = UserAccount.objects.get_or_create(
        username="admin",
        defaults={
            "name": "System Administrator",
            "role": "admin",
            "phone": ""
        }
    )
    if created or not user.password:
        user.set_password("admin123")
        user.save()
