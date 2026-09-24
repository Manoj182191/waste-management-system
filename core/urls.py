from django.urls import path
from . import views

urlpatterns = [
    # SPA
    path('', views.index, name='index'),

    # Phone + OTP Authentication
    path('api/auth/send-otp', views.api_send_otp, name='api_send_otp'),
    path('api/auth/verify-otp', views.api_verify_otp, name='api_verify_otp'),
    path('api/auth/setup-citizen', views.api_setup_citizen, name='api_setup_citizen'),
    path('api/auth/apply-generator', views.api_apply_generator, name='api_apply_generator'),

    # Session & User Profile
    path('api/auth/me', views.api_me, name='api_me'),
    path('api/auth/logout', views.api_logout, name='api_logout'),

    # Admin Generator Review
    path('api/admin/generator-applications', views.api_admin_generator_applications, name='api_admin_generator_applications'),
    path('api/admin/review-generator', views.api_admin_review_generator, name='api_admin_review_generator'),
    path('api/admin/generator-documents/<int:app_id>', views.api_admin_view_document, name='api_admin_view_document'),

    # Preserved Admin & Staff Endpoints
    path('api/auth/login', views.api_login, name='api_login'),
    path('api/admin/create-collector', views.api_create_collector, name='api_create_collector'),
    path('api/admin/create-admin', views.api_create_admin, name='api_create_admin'),

    # Preserved Business Endpoints
    path('api/requests', views.handle_requests, name='handle_requests'),
    path('api/requests/<str:req_id>/assign', views.assign_request, name='assign_request'),
    path('api/requests/<str:req_id>/start', views.start_request, name='start_request'),
    path('api/requests/<str:req_id>/complete', views.complete_request, name='complete_request'),
    path('api/collectors', views.get_collectors, name='get_collectors'),
    path('api/collector/stats', views.get_collector_stats, name='get_collector_stats'),
]
