import json
from django.test import TestCase, Client
from django.utils import timezone
from .models import UserAccount, WasteRequest, OTPRecord, GeneratorApplication
from .auth_utils import create_auth_session

class WasteManagementSystemTests(TestCase):
    def setUp(self):
        self.client = Client()
        # Create Admin
        self.admin = UserAccount.objects.create(
            username='admin_test',
            name='Test Admin',
            role='admin',
            phone='1234567890',
            status='active'
        )
        self.admin.set_password('AdminPass123!')
        self.admin.save()
        self.admin_token = create_auth_session(self.admin)

        # Create Collector
        self.collector = UserAccount.objects.create(
            username='collector_bob',
            name='Bob Collector',
            role='collector',
            phone='9876543210',
            status='active'
        )
        self.collector.set_password('CollectorPass123!')
        self.collector.save()
        self.collector_token = create_auth_session(self.collector)
        self.collector.save()

        # Create Citizen
        self.citizen = UserAccount.objects.create(
            username='citizen_alice',
            name='Alice Citizen',
            role='citizen',
            phone='5551234567',
            status='active'
        )
        self.citizen.save()
        self.citizen_token = create_auth_session(self.citizen)

    def test_auth_me_valid_token(self):
        response = self.client.get(
            '/api/auth/me',
            HTTP_AUTHORIZATION=f'Bearer {self.collector_token}'
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data.get('authenticated'))
        self.assertEqual(data['user']['username'], 'collector_bob')
        self.assertEqual(data['user']['role'], 'collector')

    def test_auth_me_unauthorized(self):
        response = self.client.get('/api/auth/me')
        self.assertEqual(response.status_code, 401)

    def test_create_and_fetch_requests(self):
        # Create a request
        req_data = {
            'id': 'REQ-1001',
            'type': 'Plastic',
            'location': '42 Green St',
            'status': 'pending',
            'citizenName': 'Alice Citizen',
            'priority': 'high'
        }
        res = self.client.post(
            '/api/requests',
            data=json.dumps(req_data),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 201)

        # Fetch as citizen
        res_citizen = self.client.get('/api/requests?role=citizen&name=Alice Citizen')
        self.assertEqual(res_citizen.status_code, 200)
        items = res_citizen.json()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['id'], 'REQ-1001')
        self.assertEqual(items[0]['priority'], 'high')

    def test_assign_start_and_complete_request_workflow(self):
        # Create request
        req = WasteRequest.objects.create(
            id='REQ-2001',
            type='Organic',
            location='10 Market St',
            status='pending',
            citizen_name='Alice Citizen',
            priority='medium'
        )

        # Admin assigns to collector
        res_assign = self.client.put(
            f'/api/requests/{req.id}/assign',
            data=json.dumps({'collector': 'Bob Collector'}),
            content_type='application/json'
        )
        self.assertEqual(res_assign.status_code, 200)
        req.refresh_from_db()
        self.assertEqual(req.status, 'assigned')
        self.assertEqual(req.collector, 'Bob Collector')

        # Collector starts task
        res_start = self.client.put(
            f'/api/requests/{req.id}/start',
            HTTP_AUTHORIZATION=f'Bearer {self.collector_token}'
        )
        self.assertEqual(res_start.status_code, 200)
        req.refresh_from_db()
        self.assertEqual(req.status, 'in_progress')
        self.assertIsNotNone(req.started_at)

        # Collector completes task with notes
        res_complete = self.client.put(
            f'/api/requests/{req.id}/complete',
            data=json.dumps({'notes': 'Collected 2 full bags. Area cleared.'}),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {self.collector_token}'
        )
        self.assertEqual(res_complete.status_code, 200)
        req.refresh_from_db()
        self.assertEqual(req.status, 'completed')
        self.assertEqual(req.notes, 'Collected 2 full bags. Area cleared.')
        self.assertIsNotNone(req.completed_at)

    def test_collector_stats(self):
        # Create assigned, in_progress, and completed requests
        now = timezone.now()
        WasteRequest.objects.create(
            id='REQ-3001',
            type='Household',
            location='Loc 1',
            status='assigned',
            collector='Bob Collector'
        )
        WasteRequest.objects.create(
            id='REQ-3002',
            type='E-Waste',
            location='Loc 2',
            status='in_progress',
            collector='Bob Collector',
            started_at=now
        )
        WasteRequest.objects.create(
            id='REQ-3003',
            type='Hazardous',
            location='Loc 3',
            status='completed',
            collector='Bob Collector',
            started_at=now,
            completed_at=now
        )

        res = self.client.get(
            '/api/collector/stats',
            HTTP_AUTHORIZATION=f'Bearer {self.collector_token}'
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['total'], 3)
        self.assertEqual(data['assigned'], 1)
        self.assertEqual(data['in_progress'], 1)
        self.assertEqual(data['completed_today'], 1)
        self.assertEqual(data['completed_total'], 1)

    def test_get_collectors(self):
        res = self.client.get('/api/collectors')
        self.assertEqual(res.status_code, 200)
        collectors = res.json()
        self.assertTrue(any(c['username'] == 'collector_bob' for c in collectors))

    def test_generator_application_and_review(self):
        # Create an applicant user
        applicant = UserAccount.objects.create(
            username='facility_manager',
            name='Hospital Mgr',
            role='citizen',
            phone='9998887776',
            status='active'
        )
        app_token = create_auth_session(applicant)

        # Apply for generator
        app_data = {
            'phone': '9998887776',
            'business_name': 'City General Hospital',
            'applicant_name': 'Hospital Mgr',
            'email': 'mgr@hospital.com',
            'address': '100 Health Way',
            'id_type': 'business_registration',
            'id_number': 'REG-991823'
        }
        res_app = self.client.post(
            '/api/auth/apply-generator',
            data=app_data,
            HTTP_AUTHORIZATION=f'Bearer {app_token}'
        )
        self.assertEqual(res_app.status_code, 201)
        app_obj = GeneratorApplication.objects.get(phone='+919998887776')
        app_id = app_obj.id

        # Admin fetches applications
        res_list = self.client.get(
            '/api/admin/generator-applications',
            HTTP_AUTHORIZATION=f'Bearer {self.admin_token}'
        )
        self.assertEqual(res_list.status_code, 200)

        # Admin approves application
        res_review = self.client.post(
            '/api/admin/review-generator',
            data=json.dumps({
                'application_id': app_id,
                'action': 'approve',
                'review_notes': 'Verified clinical license and waste permits.'
            }),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {self.admin_token}'
        )
        self.assertEqual(res_review.status_code, 200)
        applicant.refresh_from_db()
        self.assertEqual(applicant.role, 'generator')
