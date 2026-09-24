import getpass
from django.core.management.base import BaseCommand
from core.models import UserAccount

class Command(BaseCommand):
    help = 'Create a new Admin account for the Waste Management System'

    def add_arguments(self, parser):
        parser.add_argument('--username', type=str, help='Username for the admin')
        parser.add_argument('--name', type=str, help='Full name for the admin')
        parser.add_argument('--password', type=str, help='Password for the admin')
        parser.add_argument('--phone', type=str, default='', help='Phone number (optional)')

    def handle(self, *args, **options):
        self.stdout.write(self.style.NOTICE("=== Create Admin Account ==="))

        username = options.get('username')
        if not username:
            username = input("Username: ").strip()

        if not username:
            self.stderr.write(self.style.ERROR("Error: Username cannot be blank."))
            return

        if UserAccount.objects.filter(username__iexact=username).exists():
            existing = UserAccount.objects.get(username__iexact=username)
            if existing.role == 'admin':
                self.stdout.write(self.style.WARNING(f"Admin '{username}' already exists. Updating password..."))
                password = options.get('password')
                if not password:
                    password = getpass.getpass("New Password: ")
                existing.set_password(password)
                existing.save()
                self.stdout.write(self.style.SUCCESS(f"Password updated successfully for admin '{username}'."))
                return
            else:
                self.stderr.write(self.style.ERROR(f"Error: An account with username '{username}' already exists with role '{existing.role}'."))
                return

        name = options.get('name')
        if not name:
            name = input("Full Name: ").strip()
            if not name:
                name = username.capitalize()

        password = options.get('password')
        if not password:
            while True:
                password = getpass.getpass("Password: ")
                if len(password) < 6:
                    self.stdout.write(self.style.WARNING("Password must be at least 6 characters. Try again."))
                    continue
                confirm_password = getpass.getpass("Confirm Password: ")
                if password != confirm_password:
                    self.stdout.write(self.style.WARNING("Passwords do not match. Try again."))
                    continue
                break

        phone = options.get('phone') or ''
        if not phone and not options.get('username'):
            phone = input("Phone Number (optional): ").strip()

        admin = UserAccount(
            username=username,
            name=name,
            role='admin',
            phone=phone
        )
        admin.set_password(password)
        admin.save()

        self.stdout.write(self.style.SUCCESS(f"Admin account '{username}' ({name}) created successfully!"))
