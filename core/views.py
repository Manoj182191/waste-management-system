import json
import uuid
import os
from django.shortcuts import render
from django.http import JsonResponse, FileResponse, Http404
from django.views.decorators.csrf import csrf_exempt
from django.db.models import Q
from django.conf import settings
from .models import WasteRequest, UserAccount, GeneratorApplication
from .seed import seed_admin
from .otp_service import OTPService
from .auth_utils import (
    create_auth_session,
    get_authenticated_user,
    revoke_auth_session,
    require_auth
)


def find_user_by_phone(phone_str):
    """Flexible phone number lookup supporting normalized, 10-digit, and partial matches."""
    if not phone_str:
        return None
    normalized = OTPService.normalize_phone(phone_str)
    digits = "".join(filter(str.isdigit, str(phone_str)))
    last_10 = digits[-10:] if len(digits) >= 10 else digits
    
    # 1. Exact match on normalized (+91XXXXXXXXXX)
    user = UserAccount.objects.filter(phone=normalized).first()
    if user:
        return user
    
    # 2. Match on 10-digit format
    if last_10:
        user = UserAccount.objects.filter(
            Q(phone=last_10) | Q(phone__endswith=last_10)
        ).first()
        if user:
            return user
            
    return None


def index(request):
    """Ensure the system admin account exists (standard bootstrap) and render SPA."""
    if not UserAccount.objects.filter(role='admin').exists():
        seed_admin()
    return render(request, 'core/index.html')


# ==============================================================================
# PHONE + OTP AUTHENTICATION ENDPOINTS
# ==============================================================================

@csrf_exempt
def api_send_otp(request):
    """
    Generate and dispatch a single-use OTP to the user's mobile number.
    Rate-limited and secure.
    """
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        data = json.loads(request.body)
        raw_phone = data.get('phone', '').strip()
        purpose = data.get('purpose', 'auth').strip()

        if not raw_phone:
            return JsonResponse({"error": "Mobile number is required"}, status=400)

        normalized_phone = OTPService.normalize_phone(raw_phone)
        if len(normalized_phone) < 10:
            return JsonResponse({"error": "Please enter a valid 10-digit mobile number"}, status=400)

        # Check if user already exists
        existing_user = find_user_by_phone(normalized_phone)

        # Generate & send OTP
        success, otp_code, err_msg = OTPService.generate_and_send_otp(normalized_phone, purpose=purpose)
        if not success:
            return JsonResponse({"error": err_msg or "Failed to send OTP"}, status=429 if "wait" in (err_msg or "") or "Too many" in (err_msg or "") else 400)

        response_data = {

            "success": True,
            "message": f"OTP sent to {normalized_phone}",
            "phone": normalized_phone,
            "exists": existing_user is not None,
            "user_status": existing_user.status if existing_user else None,
            "user_role": existing_user.role if existing_user else None,
        }

        # In development mode, provide the OTP for immediate testing convenience
        if settings.DEBUG:
            response_data["dev_otp"] = otp_code

        return JsonResponse(response_data, status=200)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
def api_verify_otp(request):
    """
    Verify the entered OTP.
    - If user exists and is active: returns persistent session token and user info.
    - If user exists and is pending generator: returns application status without dashboard access.
    - If user exists and is rejected: returns rejection notice.
    - If user is new: returns is_new=True so frontend prompts for Citizen Setup or Generator Application.
    """
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        data = json.loads(request.body)
        raw_phone = data.get('phone', '').strip()
        otp_input = data.get('otp', '').strip()
        purpose = data.get('purpose', 'auth').strip()

        if not raw_phone or not otp_input:
            return JsonResponse({"error": "Mobile number and OTP are required"}, status=400)

        normalized_phone = OTPService.normalize_phone(raw_phone)
        is_valid, msg = OTPService.verify_otp(normalized_phone, otp_input, purpose=purpose)

        if not is_valid:
            return JsonResponse({"error": msg}, status=400)

        # Check existing user using robust flexible lookup
        user = find_user_by_phone(normalized_phone)

        if not user:
            # New user: needs profile setup or generator application
            return JsonResponse({
                "success": True,
                "is_new": True,
                "phone": normalized_phone,
                "message": "OTP verified. Please complete your registration."
            }, status=200)

        # Existing user - evaluate account status
        if user.status == 'pending':
            app = GeneratorApplication.objects.filter(user=user).order_by('-created_at').first()
            return JsonResponse({
                "success": True,
                "is_new": False,
                "status": "pending",
                "role": user.role,
                "message": "Your application is under municipal review.",
                "application": {
                    "business_name": app.business_name if app else "",
                    "applied_date": app.created_at.strftime('%Y-%m-%d %H:%M') if app else "",
                    "status": "pending"
                }
            }, status=200)

        if user.status == 'rejected':
            app = GeneratorApplication.objects.filter(user=user).order_by('-created_at').first()
            return JsonResponse({
                "success": True,
                "is_new": False,
                "status": "rejected",
                "role": user.role,
                "message": "Your application was not approved.",
                "reason": app.rejection_reason if app and app.rejection_reason else "Application requirements not met."
            }, status=200)

        # Active user (Citizen, Collector, Generator, Admin) - generate persistent session token
        token = create_auth_session(user)

        return JsonResponse({
            "success": True,
            "is_new": False,
            "status": "active",
            "token": token,
            "user": {
                "username": user.username,
                "name": user.name,
                "role": user.role,
                "phone": user.phone or "",
                "email": user.email or "",
                "status": user.status
            }
        }, status=200)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
def api_setup_citizen(request):
    """
    Complete Citizen profile setup after phone verification.
    Strictly enforces role = 'citizen' and status = 'active' for new users.
    If already a staff collector/admin, preserves their staff role!
    """
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        data = json.loads(request.body)
        raw_phone = data.get('phone', '').strip()
        name = data.get('name', '').strip()
        address = data.get('address', '').strip()
        email = data.get('email', '').strip()

        if not raw_phone or not name:
            return JsonResponse({"error": "Full name and phone number are required"}, status=400)

        normalized_phone = OTPService.normalize_phone(raw_phone)

        # Check if already registered
        user = find_user_by_phone(normalized_phone)
        if user:
            # If user already exists as collector, generator, or admin, do not downgrade to citizen!
            if user.role in ['collector', 'admin', 'generator']:
                user.name = name or user.name
                user.status = 'active'
                user.save()
                token = create_auth_session(user)
                return JsonResponse({
                    "success": True,
                    "message": f"Welcome back, {user.name}!",
                    "token": token,
                    "user": {
                        "username": user.username,
                        "name": user.name,
                        "role": user.role,
                        "phone": user.phone or "",
                        "email": user.email or "",
                        "status": user.status
                    }
                }, status=200)

            # Otherwise update citizen
            user.name = name
            user.address = address
            user.email = email
            user.role = 'citizen'
            user.status = 'active'
            user.save()
        else:
            # Generate unique username
            clean_digits = "".join(filter(str.isdigit, normalized_phone))[-10:]
            username = f"citizen_{clean_digits}"
            if UserAccount.objects.filter(username=username).exists():
                username = f"citizen_{uuid.uuid4().hex[:6]}"

            user = UserAccount.objects.create(
                username=username,
                name=name,
                phone=normalized_phone,
                email=email,
                address=address,
                role='citizen',
                status='active'
            )

        token = create_auth_session(user)

        return JsonResponse({
            "success": True,
            "message": "Citizen profile created successfully",
            "token": token,
            "user": {
                "username": user.username,
                "name": user.name,
                "role": user.role,
                "phone": user.phone or "",
                "email": user.email or "",
                "status": user.status
            }
        }, status=201)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
def api_apply_generator(request):
    """
    Submit an application to become a Commercial/Bulk Waste Generator.
    Account is created in 'pending' status and cannot access dashboard until approved by Admin.
    """
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        raw_phone = request.POST.get('phone', '').strip()
        business_name = request.POST.get('business_name', '').strip()
        applicant_name = request.POST.get('applicant_name', '').strip()
        email = request.POST.get('email', '').strip()
        address = request.POST.get('address', '').strip()
        id_type = request.POST.get('id_type', '').strip()
        id_number = request.POST.get('id_number', '').strip()
        doc_file = request.FILES.get('document_file')

        if not raw_phone or not business_name or not applicant_name or not address or not id_type or not id_number:
            return JsonResponse({
                "error": "All required fields (Phone, Business Name, Applicant Name, Address, ID Type, and ID Number) must be provided."
            }, status=400)

        normalized_phone = OTPService.normalize_phone(raw_phone)

        # Look up or create user with role='generator', status='pending'
        user = UserAccount.objects.filter(phone=normalized_phone).first()
        if not user:
            clean_digits = "".join(filter(str.isdigit, normalized_phone))[-10:]
            username = f"gen_{clean_digits}"
            if UserAccount.objects.filter(username=username).exists():
                username = f"gen_{uuid.uuid4().hex[:6]}"

            user = UserAccount.objects.create(
                username=username,
                name=applicant_name,
                phone=normalized_phone,
                email=email,
                address=address,
                role='generator',
                status='pending'
            )
        else:
            user.name = applicant_name
            user.email = email
            user.address = address
            user.role = 'generator'
            user.status = 'pending'
            user.save()

        # Create or update GeneratorApplication record
        app, _ = GeneratorApplication.objects.update_or_create(
            user=user,
            defaults={
                "business_name": business_name,
                "applicant_name": applicant_name,
                "phone": normalized_phone,
                "email": email,
                "address": address,
                "id_type": id_type,
                "id_number": id_number,
                "document_file": doc_file if doc_file else None,
                "status": "pending",
                "rejection_reason": ""
            }
        )

        return JsonResponse({
            "success": True,
            "status": "pending",
            "message": "Your Waste Generator application has been submitted and is under municipal review.",
            "application": {
                "business_name": app.business_name,
                "applicant_name": app.applicant_name,
                "phone": app.phone,
                "id_type": app.id_type,
                "id_number": app.id_number,
                "status": app.status,
                "created_at": app.created_at.strftime('%Y-%m-%d %H:%M')
            }
        }, status=201)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


# ==============================================================================
# SESSION & USER VERIFICATION ENDPOINTS
# ==============================================================================

def api_me(request):
    """
    Validate the persistent session token from request headers.
    Restores session on page reload or app reopen.
    """
    user, session = get_authenticated_user(request)
    if not user:
        return JsonResponse({"authenticated": False, "error": "Invalid or expired session"}, status=401)

    if user.status != 'active':
        return JsonResponse({
            "authenticated": False,
            "status": user.status,
            "role": user.role,
            "error": f"Account is {user.status}"
        }, status=403)

    return JsonResponse({
        "authenticated": True,
        "user": {
            "username": user.username,
            "name": user.name,
            "role": user.role,
            "phone": user.phone or "",
            "email": user.email or "",
            "address": user.address or "",
            "status": user.status
        }
    }, status=200)


@csrf_exempt
def api_logout(request):
    """Explicit logout - revokes persistent session token."""
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    revoke_auth_session(request)
    return JsonResponse({"success": True, "message": "Logged out successfully"}, status=200)


# ==============================================================================
# ADMIN GENERATOR APPLICATIONS REVIEW
# ==============================================================================

@require_auth(allowed_roles=['admin'])
def api_admin_generator_applications(request):
    """List all generator applications for admin review."""
    apps = GeneratorApplication.objects.select_related('user').all().order_by('-created_at')
    result = []
    for a in apps:
        result.append({
            "id": a.id,
            "business_name": a.business_name,
            "applicant_name": a.applicant_name,
            "phone": a.phone,
            "email": a.email or "",
            "address": a.address,
            "id_type": a.id_type,
            "id_number": a.id_number,
            "has_document": bool(a.document_file),
            "status": a.status,
            "rejection_reason": a.rejection_reason or "",
            "created_at": a.created_at.strftime('%Y-%m-%d %H:%M')
        })
    return JsonResponse(result, safe=False)


@csrf_exempt
@require_auth(allowed_roles=['admin'])
def api_admin_review_generator(request):
    """Admin endpoint to Approve or Reject a generator application."""
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        data = json.loads(request.body)
        app_id = data.get('application_id')
        action = data.get('action', '').strip().lower() # 'approve' or 'reject'
        reason = data.get('rejection_reason', '').strip()

        app = GeneratorApplication.objects.select_related('user').filter(id=app_id).first()
        if not app:
            return JsonResponse({"error": "Application not found"}, status=404)

        if action == 'approve':
            app.status = 'approved'
            app.rejection_reason = ""
            app.save()

            # Activate user account and assign generator role
            user = app.user
            user.status = 'active'
            user.role = 'generator'
            user.save()

            return JsonResponse({
                "success": True,
                "message": f"Generator application for '{app.business_name}' approved successfully!",
                "status": "approved"
            }, status=200)

        elif action == 'reject':
            app.status = 'rejected'
            app.rejection_reason = reason or "Application rejected by municipal administrator."
            app.save()

            # Keep user access disabled
            user = app.user
            user.status = 'rejected'
            user.save()

            return JsonResponse({
                "success": True,
                "message": f"Generator application for '{app.business_name}' rejected.",
                "status": "rejected"
            }, status=200)

        else:
            return JsonResponse({"error": "Invalid action. Must be 'approve' or 'reject'."}, status=400)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@require_auth(allowed_roles=['admin'])
def api_admin_view_document(request, app_id):
    """Secure endpoint for admin to view/download uploaded application documents."""
    app = GeneratorApplication.objects.filter(id=app_id).first()
    if not app or not app.document_file:
        raise Http404("Document not found")

    file_path = app.document_file.path
    if not os.path.exists(file_path):
        raise Http404("File does not exist")

    return FileResponse(open(file_path, 'rb'))


# ==============================================================================
# ADMIN & COLLECTOR MANAGEMENT (PRESERVED)
# ==============================================================================

@csrf_exempt
def api_login(request):
    """
    Password-based login reserved for authorized Municipal Administrators & Staff.
    Returns persistent session token on success.
    """
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)
    
    try:
        data = json.loads(request.body)
        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        role = data.get('role', '').strip()

        if not username or not password:
            return JsonResponse({"error": "Username and password are required"}, status=400)

        user = UserAccount.objects.filter(username__iexact=username).first()
        if not user or not user.verify_password(password):
            return JsonResponse({"error": "Invalid username or password"}, status=401)

        # Enforce server-side role check only if specific role is requested
        if role and role.lower() not in ['staff', 'any'] and user.role.lower() != role.lower():
            return JsonResponse({
                "error": f"Access denied: Account '{username}' is registered as a {user.role}, not {role}."
            }, status=403)

        if user.status != 'active':
            return JsonResponse({"error": f"Account is {user.status}. Access denied."}, status=403)

        # Generate persistent session token
        token = create_auth_session(user)

        return JsonResponse({
            "success": True,
            "message": "Login successful",
            "token": token,
            "user": {
                "username": user.username,
                "name": user.name,
                "role": user.role,
                "phone": user.phone or "",
                "status": user.status
            }
        }, status=200)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
def api_create_collector(request):
    """Admin-only endpoint to create collector accounts."""
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        # Check authentication (either bearer token or adminUsername parameter)
        user, _ = get_authenticated_user(request)
        data = json.loads(request.body)
        admin_username = data.get('adminUsername', '').strip()

        if not (user and user.role == 'admin') and not (admin_username and UserAccount.objects.filter(username__iexact=admin_username, role='admin').exists()):
            return JsonResponse({"error": "Unauthorized: Admin access required"}, status=403)

        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        name = data.get('name', '').strip()
        raw_phone = data.get('phone', '').strip()
        normalized_phone = OTPService.normalize_phone(raw_phone) if raw_phone else ''

        if not username or not password or not name:
            return JsonResponse({"error": "Username, password, and name are required"}, status=400)

        # Check if an account already exists by username or phone
        existing = UserAccount.objects.filter(username__iexact=username).first()
        if not existing and normalized_phone:
            existing = find_user_by_phone(normalized_phone)

        if existing:
            existing.username = username
            existing.name = name
            existing.role = 'collector'
            existing.status = 'active'
            if normalized_phone:
                existing.phone = normalized_phone
            existing.set_password(password)
            existing.save()
            collector = existing
        else:
            collector = UserAccount(
                username=username,
                name=name,
                role='collector',
                status='active',
                phone=normalized_phone
            )
            collector.set_password(password)
            collector.save()

        return JsonResponse({
            "success": True,
            "message": f"Collector account '{username}' created successfully",
            "collector": {
                "username": collector.username,
                "name": collector.name,
                "role": collector.role,
                "phone": collector.phone or ""
            }
        }, status=201)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@csrf_exempt
def api_create_admin(request):
    """Admin-only endpoint to create another admin account."""
    if request.method != 'POST':
        return JsonResponse({"error": "POST method required"}, status=405)

    try:
        user, _ = get_authenticated_user(request)
        data = json.loads(request.body)
        admin_username = data.get('adminUsername', '').strip()

        if not (user and user.role == 'admin') and not (admin_username and UserAccount.objects.filter(username__iexact=admin_username, role='admin').exists()):
            return JsonResponse({"error": "Unauthorized: Admin access required"}, status=403)

        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        name = data.get('name', '').strip()
        phone = data.get('phone', '').strip()

        if not username or not password or not name:
            return JsonResponse({"error": "Username, password, and name are required"}, status=400)

        if len(password) < 6:
            return JsonResponse({"error": "Password must be at least 6 characters"}, status=400)

        if UserAccount.objects.filter(username__iexact=username).exists():
            return JsonResponse({"error": "Username already taken"}, status=400)

        admin = UserAccount(
            username=username,
            name=name,
            role='admin',
            status='active',
            phone=phone
        )
        admin.set_password(password)
        admin.save()

        return JsonResponse({
            "success": True,
            "message": f"Admin account '{username}' created successfully",
            "admin": {
                "username": admin.username,
                "name": admin.name,
                "role": admin.role,
                "phone": admin.phone or ""
            }
        }, status=201)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


# ==============================================================================
# WASTE MANAGEMENT BUSINESS APIS (PRESERVED)
# ==============================================================================

@csrf_exempt
def handle_requests(request):
    """
    Preserved waste request handling:
    - Citizens & Generators view their submitted requests.
    - Collectors view their assigned tasks.
    - Admins view all requests.
    """
    if request.method == 'GET':
        role = request.GET.get('role')
        name = request.GET.get('name')
        username = request.GET.get('username')
        
        if role in ['citizen', 'generator']:
            query = Q()
            if name:
                query |= Q(citizen_name=name)
            if username:
                query |= Q(citizen_name=username)
            reqs = WasteRequest.objects.filter(query).order_by('-date')
        elif role == 'collector':
            query = Q()
            if name:
                query |= Q(collector=name)
            if username:
                query |= Q(collector=username)
            reqs = WasteRequest.objects.filter(query).order_by('-date')
        else: # Admin sees all
            reqs = WasteRequest.objects.all().order_by('-date')
            
        requests_list = list(reqs.values('id', 'type', 'location', 'status', 'date', 'citizen_name', 'collector', 'priority', 'notes', 'started_at', 'completed_at'))
        return JsonResponse(requests_list, safe=False)
        
    elif request.method == 'POST':
        try:
            data = json.loads(request.body)
            from django.utils import timezone
            WasteRequest.objects.create(
                id=data.get('id'),
                type=data.get('type', 'General'),
                location=data.get('location', 'Unspecified'),
                status=data.get('status', 'pending'),
                date=data.get('date') or timezone.now().isoformat(),
                citizen_name=data.get('citizenName', 'Citizen'),
                priority=data.get('priority', 'medium')
            )
            return JsonResponse({"message": "Request created successfully"}, status=201)
        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)
    
    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def assign_request(request, req_id):
    """Assign a request to a collector (Admin action)."""
    if request.method == 'PUT':
        data = json.loads(request.body)
        collector = data.get('collector')
        try:
            req = WasteRequest.objects.get(id=req_id)
            req.status = 'assigned'
            req.collector = collector
            req.save()
            return JsonResponse({"message": "Request assigned successfully"}, status=200)
        except WasteRequest.DoesNotExist:
            return JsonResponse({"error": "Request not found"}, status=404)
    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def complete_request(request, req_id):
    """Mark a collection task complete (Collector action). Optionally accepts notes."""
    if request.method == 'PUT':
        try:
            from django.utils import timezone
            data = json.loads(request.body) if request.body else {}
            req = WasteRequest.objects.get(id=req_id)
            req.status = 'completed'
            req.completed_at = timezone.now()
            if data.get('notes'):
                req.notes = data['notes']
            req.save()
            return JsonResponse({"message": "Request marked as completed"}, status=200)
        except WasteRequest.DoesNotExist:
            return JsonResponse({"error": "Request not found"}, status=404)
    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def start_request(request, req_id):
    """Move a request from assigned → in_progress (Collector starts working on it)."""
    if request.method == 'PUT':
        try:
            from django.utils import timezone
            req = WasteRequest.objects.get(id=req_id)
            if req.status != 'assigned':
                return JsonResponse({"error": f"Cannot start a request with status '{req.status}'"}, status=400)
            req.status = 'in_progress'
            req.started_at = timezone.now()
            req.save()
            return JsonResponse({"message": "Task started — now in progress"}, status=200)
        except WasteRequest.DoesNotExist:
            return JsonResponse({"error": "Request not found"}, status=404)
    return JsonResponse({"error": "Method not allowed"}, status=405)


def get_collectors(request):
    """Fetch active collectors for assignment dropdown."""
    collectors = UserAccount.objects.filter(role='collector', status='active')
    collectors_data = [
        {"username": c.username, "name": c.name, "phone": c.phone}
        for c in collectors
    ]
    return JsonResponse(collectors_data, safe=False)


def get_collector_stats(request):
    """Return task summary stats for the authenticated collector."""
    user, _ = get_authenticated_user(request)
    if not user or user.role != 'collector':
        return JsonResponse({"error": "Collector authentication required"}, status=403)

    from django.utils import timezone
    today_start = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)

    # Filter tasks belonging to this collector
    name = user.name
    username = user.username
    tasks = WasteRequest.objects.filter(
        Q(collector=name) | Q(collector=username)
    )

    total = tasks.count()
    assigned = tasks.filter(status='assigned').count()
    in_progress = tasks.filter(status='in_progress').count()
    completed_today = tasks.filter(status='completed', completed_at__gte=today_start).count()
    completed_total = tasks.filter(status='completed').count()

    return JsonResponse({
        "total": total,
        "assigned": assigned,
        "in_progress": in_progress,
        "completed_today": completed_today,
        "completed_total": completed_total,
    })
