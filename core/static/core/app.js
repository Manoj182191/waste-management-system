/**
 * Smart Waste Management System
 * Phone Number + OTP Authentication & Modern Role-Based Onboarding
 * Roles: CITIZEN, GENERATOR, ADMIN (and legacy collector)
 */

// --- Global State ---
let currentUser = null;
let currentRequests = [];
let availableCollectors = [];
let generatorApplications = [];

// Auth State Machine
// authStep: 'phone' | 'otp' | 'citizen_setup' | 'generator_apply' | 'generator_status' | 'admin_password'
let authStep = 'phone';
let inputPhone = '';
let inputOtp = '';
let devOtp = '';
let authError = '';
let authLoading = false;
let isGeneratorFlow = false;
let resendTimer = 0;
let resendInterval = null;
let generatorStatusData = null;

// Admin UI State
let adminTab = 'requests'; // 'requests' | 'applications' | 'collectors'
let showCreateCollector = false;
let createCollectorError = '';
let createCollectorLoading = false;
let showCreateAdmin = false;
let createAdminError = '';
let createAdminLoading = false;

// Collector UI State
let collectorStats = { total: 0, assigned: 0, in_progress: 0, completed_today: 0, completed_total: 0 };
let collectorAutoRefresh = null;  // setInterval handle
let notesModalReqId = null;       // ID of request pending completion with notes

// API Base URL
const API_BASE = '/api';

// --- Utilities ---

function getAuthToken() {
    return localStorage.getItem('swms_token') || '';
}

function authHeaders(isJson = true) {
    const headers = {};
    if (isJson) headers['Content-Type'] = 'application/json';
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function showNotification(message, isError = false) {
    const container = document.getElementById('notification-container');
    if (!container) return;
    
    const notif = document.createElement('div');
    notif.className = `notification ${isError ? 'notification-error' : ''}`;
    notif.innerHTML = `
        <i class="fas ${isError ? 'fa-exclamation-circle' : 'fa-check-circle'}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(notif);
    setTimeout(() => notif.classList.add('show'), 10);
    setTimeout(() => {
        notif.classList.remove('show');
        setTimeout(() => notif.remove(), 300);
    }, 3500);
}

function formatDate(dateString) {
    if (!dateString) return '';
    let dateObj;
    if (dateString.includes('T')) {
         dateObj = new Date(dateString);
    } else {
         dateObj = new Date(dateString.replace(' ', 'T'));
    }
    if (isNaN(dateObj.getTime())) return dateString;
    const options = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return dateObj.toLocaleDateString(undefined, options);
}

function getStatusBadge(status) {
    const badges = {
        'pending': '<span class="badge badge-pending">Pending</span>',
        'assigned': '<span class="badge badge-assigned">Assigned</span>',
        'completed': '<span class="badge badge-completed">Completed</span>',
        'approved': '<span class="badge badge-completed">Approved</span>',
        'rejected': '<span class="badge" style="background:#fee2e2;color:#dc2626;">Rejected</span>'
    };
    return badges[status] || `<span class="badge">${status}</span>`;
}

function startResendTimer() {
    resendTimer = 30;
    if (resendInterval) clearInterval(resendInterval);
    resendInterval = setInterval(() => {
        resendTimer--;
        if (resendTimer <= 0) {
            clearInterval(resendInterval);
            resendInterval = null;
        }
        // Update timer text without full re-render if element exists
        const timerElem = document.getElementById('resend-timer-text');
        if (timerElem) {
            if (resendTimer > 0) {
                timerElem.innerText = `Resend OTP in ${resendTimer}s`;
            } else {
                timerElem.innerHTML = `<a href="javascript:void(0)" onclick="handleResendOTP()" style="color:var(--primary);font-weight:600;text-decoration:none;">Resend OTP</a>`;
            }
        }
    }, 1000);
}

// ==============================================================================
// AUTHENTICATION FLOWS (PHONE + OTP)
// ==============================================================================

function setAuthStep(step, isGen = false) {
    authStep = step;
    if (isGen !== undefined) isGeneratorFlow = isGen;
    authError = '';
    renderApp();
}

async function handleSendOTP(event) {
    if (event) event.preventDefault();
    authError = '';

    const phoneField = document.getElementById('phone-number-input');
    const phoneVal = phoneField ? phoneField.value.trim() : inputPhone;

    if (!phoneVal || phoneVal.replace(/\D/g, '').length < 10) {
        authError = 'Please enter a valid 10-digit mobile number.';
        renderApp();
        return;
    }

    inputPhone = phoneVal;
    authLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: inputPhone, purpose: 'auth' })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            inputPhone = data.phone;
            devOtp = data.dev_otp || '';
            authStep = 'otp';
            authError = '';
            startResendTimer();
            showNotification(`OTP sent to ${inputPhone}`);
        } else {
            authError = data.error || 'Failed to send OTP. Please try again.';
        }
    } catch (err) {
        authError = 'Server connection error. Please try again.';
        console.error(err);
    } finally {
        authLoading = false;
        renderApp();
    }
}

async function handleResendOTP() {
    if (resendTimer > 0) return;
    authLoading = true;
    renderApp();
    try {
        const res = await fetch(`${API_BASE}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: inputPhone, purpose: 'auth' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            devOtp = data.dev_otp || '';
            startResendTimer();
            showNotification('New OTP sent successfully!');
        } else {
            authError = data.error || 'Could not resend OTP.';
        }
    } catch (e) {
        authError = 'Network error while resending OTP.';
    } finally {
        authLoading = false;
        renderApp();
    }
}

function fillDevOtp() {
    if (!devOtp) return;
    const otpInput = document.getElementById('otp-input');
    if (otpInput) {
        otpInput.value = devOtp;
        inputOtp = devOtp;
    }
}

async function handleVerifyOTP(event) {
    if (event) event.preventDefault();
    authError = '';

    const otpField = document.getElementById('otp-input');
    const otpVal = otpField ? otpField.value.trim() : inputOtp;

    if (!otpVal || otpVal.length < 6) {
        authError = 'Please enter the 6-digit OTP received on your mobile.';
        renderApp();
        return;
    }

    inputOtp = otpVal;
    authLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: inputPhone, otp: inputOtp, purpose: 'auth' })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            // Check status branch
            if (data.is_new) {
                // New user branch
                if (isGeneratorFlow) {
                    authStep = 'generator_apply';
                } else {
                    authStep = 'citizen_setup';
                }
            } else if (data.status === 'pending') {
                // Pending generator branch
                generatorStatusData = data.application || { status: 'pending', business_name: 'Your Facility' };
                generatorStatusData.status = 'pending';
                authStep = 'generator_status';
            } else if (data.status === 'rejected') {
                // Rejected generator branch
                generatorStatusData = { status: 'rejected', reason: data.reason || 'Requirements not met.' };
                authStep = 'generator_status';
            } else if (data.token) {
                // Active authenticated user (Citizen, Generator, or Admin)
                localStorage.setItem('swms_token', data.token);
                currentUser = data.user;
                showNotification(`Welcome back, ${currentUser.name}!`);
                await fetchData();
                authStep = 'phone';
                inputOtp = '';
                devOtp = '';
            }
        } else {
            authError = data.error || 'Verification failed. Please check the OTP.';
        }
    } catch (err) {
        authError = 'Server connection error during OTP verification.';
        console.error(err);
    } finally {
        authLoading = false;
        renderApp();
    }
}

async function handleCitizenSetup(event) {
    event.preventDefault();
    authError = '';

    const name = document.getElementById('citizen-name').value.trim();
    const address = document.getElementById('citizen-address').value.trim();
    const email = document.getElementById('citizen-email').value.trim();

    if (!name || !address) {
        authError = 'Full name and address/ward are required.';
        renderApp();
        return;
    }

    authLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/auth/setup-citizen`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: inputPhone, name, address, email })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem('swms_token', data.token);
            currentUser = data.user;
            showNotification(`Welcome to Smart Waste Management, ${currentUser.name}!`);
            await fetchData();
            authStep = 'phone';
        } else {
            authError = data.error || 'Failed to complete profile setup.';
        }
    } catch (err) {
        authError = 'Server error during profile creation.';
        console.error(err);
    } finally {
        authLoading = false;
        renderApp();
    }
}

async function handleGeneratorApplication(event) {
    event.preventDefault();
    authError = '';

    const businessName = document.getElementById('gen-business-name').value.trim();
    const applicantName = document.getElementById('gen-applicant-name').value.trim();
    const address = document.getElementById('gen-address').value.trim();
    const email = document.getElementById('gen-email').value.trim();
    const idType = document.getElementById('gen-id-type').value;
    const idNumber = document.getElementById('gen-id-number').value.trim();
    const docInput = document.getElementById('gen-doc-file');

    if (!businessName || !applicantName || !address || !idType || !idNumber) {
        authError = 'Please fill in all required verification fields.';
        renderApp();
        return;
    }

    const formData = new FormData();
    formData.append('phone', inputPhone);
    formData.append('business_name', businessName);
    formData.append('applicant_name', applicantName);
    formData.append('address', address);
    formData.append('email', email);
    formData.append('id_type', idType);
    formData.append('id_number', idNumber);
    if (docInput && docInput.files.length > 0) {
        formData.append('document_file', docInput.files[0]);
    }

    authLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/auth/apply-generator`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (res.ok && data.success) {
            generatorStatusData = data.application || { status: 'pending', business_name: businessName };
            authStep = 'generator_status';
            showNotification('Application submitted successfully!');
        } else {
            authError = data.error || 'Failed to submit application.';
        }
    } catch (err) {
        authError = 'Network error while submitting application.';
        console.error(err);
    } finally {
        authLoading = false;
        renderApp();
    }
}

async function handleAdminPasswordLogin(event) {
    event.preventDefault();
    authError = '';

    const username = document.getElementById('admin-login-username').value.trim();
    const password = document.getElementById('admin-login-password').value.trim();

    if (!username || !password) {
        authError = 'Username and password are required.';
        renderApp();
        return;
    }

    authLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            if (data.token) {
                localStorage.setItem('swms_token', data.token);
            }
            currentUser = data.user;
            showNotification(`Welcome, ${currentUser.name}!`);
            await fetchData();
            authStep = 'phone';
        } else {
            authError = data.error || 'Invalid credentials.';
        }
    } catch (err) {
        authError = 'Server connection error.';
        console.error(err);
    } finally {
        authLoading = false;
        renderApp();
    }
}

async function logout() {
    stopCollectorAutoRefresh();
    try {
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: authHeaders()
        });
    } catch (e) {
        console.warn('Logout endpoint call failed', e);
    }

    currentUser = null;
    currentRequests = [];
    availableCollectors = [];
    generatorApplications = [];
    collectorStats = { total: 0, assigned: 0, in_progress: 0, completed_today: 0, completed_total: 0 };
    localStorage.removeItem('swms_token');
    authStep = 'phone';
    inputPhone = '';
    inputOtp = '';
    devOtp = '';
    authError = '';
    isGeneratorFlow = false;
    showCreateCollector = false;
    showCreateAdmin = false;
    renderApp();
    showNotification('Logged out successfully');
}

// ==============================================================================
// DATA FETCHING & BUSINESS OPERATIONS
// ==============================================================================

async function fetchData() {
    if (!currentUser) return;
    
    try {
        const queryParams = new URLSearchParams({
            role: currentUser.role,
            name: currentUser.name,
            username: currentUser.username || ''
        });

        const reqRes = await fetch(`${API_BASE}/requests?${queryParams.toString()}`, {
            headers: authHeaders()
        });
        if (reqRes.ok) {
            currentRequests = await reqRes.json();
        }
        
        if (currentUser.role === 'admin') {
            // Fetch collectors
            const colRes = await fetch(`${API_BASE}/collectors`, {
                headers: authHeaders()
            });
            if (colRes.ok) {
                availableCollectors = await colRes.json();
            }

            // Fetch generator applications
            const genAppsRes = await fetch(`${API_BASE}/admin/generator-applications`, {
                headers: authHeaders()
            });
            if (genAppsRes.ok) {
                generatorApplications = await genAppsRes.json();
            }
        }

        if (currentUser.role === 'collector') {
            await fetchCollectorStats();
        }
    } catch (e) {
        showNotification('Error syncing data with municipal server', true);
        console.error(e);
    }
}

async function submitRequest(event) {
    event.preventDefault();
    const type = document.getElementById('waste-type').value;
    const location = document.getElementById('waste-location').value;
    
    if (!type || !location) {
        showNotification('Please fill in all fields', true);
        return;
    }
    
    const newRequest = {
        id: 'req_' + Math.random().toString(36).substr(2, 9),
        type,
        location,
        status: 'pending',
        date: new Date().toISOString(),
        citizenName: currentUser.name
    };
    
    try {
        const res = await fetch(`${API_BASE}/requests`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(newRequest)
        });
        
        if (res.ok) {
            showNotification('Waste report submitted successfully!');
            await fetchData();
            renderApp();
        } else {
            showNotification('Failed to submit report', true);
        }
    } catch (e) {
        showNotification('Error connecting to server', true);
    }
}

async function assignCollector(requestId, collectorName) {
    if (!collectorName) return;
    
    try {
        const res = await fetch(`${API_BASE}/requests/${requestId}/assign`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ collector: collectorName })
        });
        
        if (res.ok) {
            showNotification(`Request assigned to ${collectorName}`);
            await fetchData();
            renderApp();
        } else {
            showNotification('Failed to assign request', true);
        }
    } catch (e) {
        showNotification('Error connecting to server', true);
    }
}

async function completeRequest(requestId) {
    // Show notes modal before completing
    notesModalReqId = requestId;
    renderApp();
    showNotesModal(requestId);
}

function showNotesModal(requestId) {
    // Remove any existing modal
    const existing = document.getElementById('notes-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'notes-modal-overlay';
    overlay.className = 'notes-modal-overlay fade-in';
    overlay.innerHTML = `
        <div class="notes-modal">
            <h3><i class="fas fa-clipboard-check" style="color:var(--primary);"></i> Complete Task</h3>
            <p>Optionally add a completion note before marking this task as done.</p>
            <textarea id="completion-notes" placeholder="e.g. Collected 3 bags, bin left at gate, extra large load..."></textarea>
            <div class="notes-modal-actions">
                <button class="btn btn-outline" onclick="closeNotesModal()">Cancel</button>
                <button class="btn btn-primary" onclick="confirmCompleteRequest('${requestId}')">
                    <i class="fas fa-check"></i> Mark Complete
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => { const ta = document.getElementById('completion-notes'); if (ta) ta.focus(); }, 50);
}

function closeNotesModal() {
    const overlay = document.getElementById('notes-modal-overlay');
    if (overlay) overlay.remove();
    notesModalReqId = null;
}

async function confirmCompleteRequest(requestId) {
    const notes = (document.getElementById('completion-notes')?.value || '').trim();
    closeNotesModal();

    try {
        const res = await fetch(`${API_BASE}/requests/${requestId}/complete`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ notes })
        });
        
        if (res.ok) {
            showNotification('Task marked as completed!');
            await fetchData();
            renderApp();
        } else {
            showNotification('Failed to mark complete', true);
        }
    } catch (e) {
        showNotification('Error connecting to server', true);
    }
}

async function startTask(requestId) {
    try {
        const res = await fetch(`${API_BASE}/requests/${requestId}/start`, {
            method: 'PUT',
            headers: authHeaders()
        });

        if (res.ok) {
            showNotification('Task started — good luck!');
            await fetchData();
            renderApp();
        } else {
            const data = await res.json();
            showNotification(data.error || 'Failed to start task', true);
        }
    } catch (e) {
        showNotification('Error connecting to server', true);
    }
}

async function fetchCollectorStats() {
    try {
        const res = await fetch(`${API_BASE}/collector/stats`, { headers: authHeaders() });
        if (res.ok) {
            collectorStats = await res.json();
        }
    } catch (e) {
        console.warn('Could not fetch collector stats', e);
    }
}

function startCollectorAutoRefresh() {
    stopCollectorAutoRefresh();
    collectorAutoRefresh = setInterval(async () => {
        if (currentUser && currentUser.role === 'collector') {
            await fetchData();
            renderApp();
        }
    }, 60000); // refresh every 60 seconds
}

function stopCollectorAutoRefresh() {
    if (collectorAutoRefresh) {
        clearInterval(collectorAutoRefresh);
        collectorAutoRefresh = null;
    }
}

// --- Admin Review of Generator Applications ---

async function handleReviewApplication(appId, action) {
    let rejectionReason = '';
    if (action === 'reject') {
        rejectionReason = prompt('Please enter the reason for rejecting this application:');
        if (rejectionReason === null) return; // User cancelled prompt
    }

    try {
        const res = await fetch(`${API_BASE}/admin/review-generator`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                application_id: appId,
                action: action,
                rejection_reason: rejectionReason
            })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            showNotification(data.message || `Application ${action}d successfully`);
            await fetchData();
            renderApp();
        } else {
            showNotification(data.error || 'Failed to review application', true);
        }
    } catch (e) {
        showNotification('Server communication error', true);
        console.error(e);
    }
}

// --- Admin: Create Collector & Admin (Preserved) ---

function toggleCreateCollector() {
    showCreateCollector = !showCreateCollector;
    showCreateAdmin = false;
    createCollectorError = '';
    renderApp();
}

function toggleCreateAdmin() {
    showCreateAdmin = !showCreateAdmin;
    showCreateCollector = false;
    createAdminError = '';
    renderApp();
}

function setAdminTab(tab) {
    adminTab = tab;
    renderApp();
}

async function handleCreateCollector(event) {
    event.preventDefault();
    createCollectorError = '';

    const name = document.getElementById('col-name').value.trim();
    const username = document.getElementById('col-username').value.trim();
    const phone = document.getElementById('col-phone').value.trim();
    const password = document.getElementById('col-password').value.trim();

    if (!name || !username || !password) {
        createCollectorError = 'Name, username, and password are required.';
        renderApp();
        return;
    }

    createCollectorLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/admin/create-collector`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ adminUsername: currentUser.username, name, username, phone, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            showNotification(`Collector "${name}" created successfully!`);
            showCreateCollector = false;
            await fetchData();
        } else {
            createCollectorError = data.error || 'Failed to create collector.';
        }
    } catch (err) {
        createCollectorError = 'Server connection error.';
    } finally {
        createCollectorLoading = false;
        renderApp();
    }
}

async function handleCreateAdmin(event) {
    event.preventDefault();
    createAdminError = '';

    const name = document.getElementById('admin-new-name').value.trim();
    const username = document.getElementById('admin-new-username').value.trim();
    const phone = document.getElementById('admin-new-phone').value.trim();
    const password = document.getElementById('admin-new-password').value.trim();

    if (!name || !username || !password) {
        createAdminError = 'Name, username, and password are required.';
        renderApp();
        return;
    }

    createAdminLoading = true;
    renderApp();

    try {
        const res = await fetch(`${API_BASE}/admin/create-admin`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ adminUsername: currentUser.username, name, username, phone, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            showNotification(`Admin account "${name}" created successfully!`);
            showCreateAdmin = false;
        } else {
            createAdminError = data.error || 'Failed to create admin.';
        }
    } catch (err) {
        createAdminError = 'Server connection error.';
    } finally {
        createAdminLoading = false;
        renderApp();
    }
}

// ==============================================================================
// UI RENDERING - AUTHENTICATION SCREENS
// ==============================================================================

function renderLogin() {
    let cardContent = '';

    // Error alert banner
    const errorHTML = authError ? `
        <div class="auth-alert-error fade-in" style="margin-bottom: 1.25rem;">
            <i class="fas fa-exclamation-circle"></i>
            <span>${authError}</span>
        </div>
    ` : '';

    if (authStep === 'phone') {
        // --- SCREEN 1: Phone Number Input ---
        cardContent = `
            <div style="text-align: center; margin-bottom: 2rem;">
                <div style="width: 64px; height: 64px; background: rgba(16, 185, 129, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem auto;">
                    <i class="fas ${isGeneratorFlow ? 'fa-industry' : 'fa-recycle'}" style="font-size: 2rem; color: var(--primary);"></i>
                </div>
                <h2>${isGeneratorFlow ? 'Commercial Waste Generator' : 'Smart Waste System'}</h2>
                <p>${isGeneratorFlow ? 'Apply or login with your mobile number' : 'Enter your mobile number to get started'}</p>
            </div>

            ${errorHTML}

            <form onsubmit="handleSendOTP(event)">
                <div class="form-group" style="margin-bottom: 1.5rem;">
                    <label style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.5rem; display: block;">
                        Mobile Number
                    </label>
                    <div class="phone-input-wrapper">
                        <div class="country-code-pill">
                            <i class="fas fa-flag" style="color: #f59e0b;"></i> +91
                        </div>
                        <input type="tel" id="phone-number-input" class="phone-number-field" 
                               placeholder="Enter 10-digit number" value="${inputPhone.replace('+91', '')}" 
                               maxlength="10" required autofocus>
                    </div>
                </div>

                <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; padding: 0.85rem;" ${authLoading ? 'disabled' : ''}>
                    ${authLoading ? '<i class="fas fa-spinner fa-spin"></i> Sending OTP...' : '<i class="fas fa-arrow-right"></i> Continue'}
                </button>
            </form>

            <div style="margin-top: 1.75rem; text-align: center; border-top: 1px solid var(--border); padding-top: 1.25rem;">
                ${!isGeneratorFlow ? `
                    <div class="auth-nav-link" onclick="setAuthStep('phone', true)" style="display: block; font-weight: 500;">
                        <i class="fas fa-building" style="color: var(--primary);"></i> Commercial or Bulk Facility? <strong>Apply as Generator</strong>
                    </div>
                ` : `
                    <div class="auth-nav-link" onclick="setAuthStep('phone', false)" style="display: block; font-weight: 500;">
                        <i class="fas fa-user"></i> Resident / Citizen? <strong>Citizen Login</strong>
                    </div>
                `}

                <div style="margin-top: 1rem;">
                    <a href="javascript:void(0)" onclick="setAuthStep('admin_password')" style="font-size: 0.8rem; color: var(--text-muted); text-decoration: none;">
                        <i class="fas fa-id-badge"></i> Municipal Staff & Admin Portal
                    </a>
                </div>
            </div>
        `;
    } else if (authStep === 'otp') {
        // --- SCREEN 2: OTP Verification ---
        cardContent = `
            <div style="text-align: center; margin-bottom: 1.5rem;">
                <div style="width: 60px; height: 60px; background: rgba(59, 130, 246, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 0.75rem auto;">
                    <i class="fas fa-shield-alt" style="font-size: 1.8rem; color: var(--secondary);"></i>
                </div>
                <h2>Verify Mobile Number</h2>
                <p style="margin-bottom: 0.25rem;">OTP sent via SMS to</p>
                <div style="font-weight: 700; color: var(--text-main); font-size: 1.05rem;">
                    ${inputPhone} 
                    <a href="javascript:void(0)" onclick="setAuthStep('phone', isGeneratorFlow)" style="color: var(--primary); font-size: 0.85rem; margin-left: 6px; text-decoration: none;">
                        <i class="fas fa-pencil-alt"></i> Edit
                    </a>
                </div>
            </div>

            ${errorHTML}

            ${devOtp ? `
                <div style="text-align: center;">
                    <div class="dev-otp-badge" onclick="fillDevOtp()" title="Click to auto-fill OTP">
                        <i class="fas fa-key"></i> Dev OTP: <strong>${devOtp}</strong> (Click to paste)
                    </div>
                </div>
            ` : ''}

            <form onsubmit="handleVerifyOTP(event)">
                <div class="form-group" style="margin-bottom: 1.5rem;">
                    <input type="text" id="otp-input" class="otp-input-field" 
                           placeholder="&bull; &bull; &bull; &bull; &bull; &bull;" 
                           maxlength="6" autofocus required>
                </div>

                <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; padding: 0.85rem;" ${authLoading ? 'disabled' : ''}>
                    ${authLoading ? '<i class="fas fa-spinner fa-spin"></i> Verifying...' : '<i class="fas fa-check-circle"></i> Verify & Proceed'}
                </button>
            </form>

            <div style="margin-top: 1.5rem; text-align: center; font-size: 0.85rem; color: var(--text-muted);" id="resend-timer-text">
                ${resendTimer > 0 ? `Resend OTP in ${resendTimer}s` : `<a href="javascript:void(0)" onclick="handleResendOTP()" style="color:var(--primary);font-weight:600;text-decoration:none;">Resend OTP</a>`}
            </div>
        `;
    } else if (authStep === 'citizen_setup') {
        // --- SCREEN 3: Citizen Profile Setup ---
        cardContent = `
            <div style="text-align: center; margin-bottom: 1.5rem;">
                <div style="width: 56px; height: 56px; background: rgba(16, 185, 129, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 0.75rem auto;">
                    <i class="fas fa-user-edit" style="font-size: 1.6rem; color: var(--primary);"></i>
                </div>
                <h2>Complete Your Profile</h2>
                <p>Welcome! Please tell us a few details to personalize your account.</p>
            </div>

            ${errorHTML}

            <form onsubmit="handleCitizenSetup(event)">
                <div class="form-group">
                    <label for="citizen-name">Full Name *</label>
                    <div class="input-with-icon">
                        <i class="fas fa-user input-icon"></i>
                        <input type="text" id="citizen-name" class="form-control" placeholder="e.g. Ramesh Kumar" required autofocus>
                    </div>
                </div>

                <div class="form-group">
                    <label>Verified Mobile</label>
                    <div class="input-with-icon">
                        <i class="fas fa-phone input-icon"></i>
                        <input type="text" class="form-control" value="${inputPhone}" disabled style="background:#f1f5f9; cursor:not-allowed;">
                    </div>
                </div>

                <div class="form-group">
                    <label for="citizen-address">Address / Ward Information *</label>
                    <div class="input-with-icon">
                        <i class="fas fa-map-marker-alt input-icon"></i>
                        <input type="text" id="citizen-address" class="form-control" placeholder="e.g. Flat 302, Sector 14, Green Park" required>
                    </div>
                </div>

                <div class="form-group">
                    <label for="citizen-email">Email Address <span style="font-weight: normal; color: var(--text-muted);">(Optional)</span></label>
                    <div class="input-with-icon">
                        <i class="fas fa-envelope input-icon"></i>
                        <input type="email" id="citizen-email" class="form-control" placeholder="name@example.com">
                    </div>
                </div>

                <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; margin-top: 1rem;" ${authLoading ? 'disabled' : ''}>
                    ${authLoading ? '<i class="fas fa-spinner fa-spin"></i> Saving...' : '<i class="fas fa-check"></i> Complete & Open Dashboard'}
                </button>
            </form>
        `;
    } else if (authStep === 'generator_apply') {
        // --- SCREEN 4: Commercial Waste Generator Application ---
        cardContent = `
            <div style="text-align: center; margin-bottom: 1.5rem;">
                <div style="width: 56px; height: 56px; background: rgba(245, 158, 11, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 0.75rem auto;">
                    <i class="fas fa-industry" style="font-size: 1.6rem; color: var(--status-pending);"></i>
                </div>
                <h2>Generator Application</h2>
                <p>Register your commercial, industrial, or bulk waste generation facility.</p>
            </div>

            ${errorHTML}

            <form onsubmit="handleGeneratorApplication(event)">
                <div class="grid-2">
                    <div class="form-group">
                        <label for="gen-business-name">Facility / Business Name *</label>
                        <div class="input-with-icon">
                            <i class="fas fa-building input-icon"></i>
                            <input type="text" id="gen-business-name" class="form-control" placeholder="e.g. Apex Hospital / Tech Park" required autofocus>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="gen-applicant-name">Authorized Representative *</label>
                        <div class="input-with-icon">
                            <i class="fas fa-user input-icon"></i>
                            <input type="text" id="gen-applicant-name" class="form-control" placeholder="Full name of applicant" required>
                        </div>
                    </div>
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label>Verified Mobile</label>
                        <div class="input-with-icon">
                            <i class="fas fa-phone input-icon"></i>
                            <input type="text" class="form-control" value="${inputPhone}" disabled style="background:#f1f5f9; cursor:not-allowed;">
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="gen-email">Official Email</label>
                        <div class="input-with-icon">
                            <i class="fas fa-envelope input-icon"></i>
                            <input type="email" id="gen-email" class="form-control" placeholder="contact@business.com">
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="gen-address">Facility Address & Municipal Ward *</label>
                    <div class="input-with-icon">
                        <i class="fas fa-map-marked-alt input-icon"></i>
                        <input type="text" id="gen-address" class="form-control" placeholder="Complete address of waste generation site" required>
                    </div>
                </div>

                <div class="grid-2">
                    <div class="form-group">
                        <label for="gen-id-type">Identification Proof Type *</label>
                        <select id="gen-id-type" class="form-control" required>
                            <option value="GSTIN Certificate">GSTIN Certificate</option>
                            <option value="Municipal Trade License">Municipal Trade License</option>
                            <option value="Pollution Control Board Permit">Pollution Control Board Permit</option>
                            <option value="Commercial Registration ID">Commercial Registration ID</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="gen-id-number">Registration / License Number *</label>
                        <div class="input-with-icon">
                            <i class="fas fa-id-card input-icon"></i>
                            <input type="text" id="gen-id-number" class="form-control" placeholder="e.g. 29ABCDE1234F1Z5" required>
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label for="gen-doc-file">Upload Proof Document (PDF, PNG, JPG) <span style="font-weight:normal;color:var(--text-muted);">(Optional)</span></label>
                    <input type="file" id="gen-doc-file" class="form-control" accept=".pdf,.png,.jpg,.jpeg">
                </div>

                <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; margin-top: 0.5rem;" ${authLoading ? 'disabled' : ''}>
                    ${authLoading ? '<i class="fas fa-spinner fa-spin"></i> Submitting Application...' : '<i class="fas fa-paper-plane"></i> Submit Application for Review'}
                </button>
            </form>
        `;
    } else if (authStep === 'generator_status') {
        // --- SCREEN 5: Generator Under Review Status ---
        const isPending = !generatorStatusData || generatorStatusData.status === 'pending';
        cardContent = `
            <div class="review-status-card">
                <div class="review-status-icon ${isPending ? 'review-icon-pending' : 'review-icon-rejected'}">
                    <i class="fas ${isPending ? 'fa-hourglass-half' : 'fa-times-circle'}"></i>
                </div>
                <h3>${isPending ? 'Application Under Municipal Review' : 'Application Not Approved'}</h3>
                <p style="margin: 0.75rem 0 1.5rem 0; line-height: 1.6;">
                    ${isPending ? 
                        `Thank you for applying. Your Commercial Waste Generator registration for <strong>${generatorStatusData.business_name || 'your facility'}</strong> has been received and is currently being verified by municipal authorities.` 
                        : 
                        `Your application was not approved at this time.<br><strong>Reason:</strong> ${generatorStatusData.reason || 'Verification criteria not satisfied.'}`
                    }
                </p>

                <div class="card" style="text-align: left; margin-bottom: 1.5rem; background: #f8fafc;">
                    <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.8;">
                        <div><i class="fas fa-phone"></i> Registered Mobile: <strong>${inputPhone}</strong></div>
                        <div><i class="fas fa-info-circle"></i> Status: ${getStatusBadge(isPending ? 'pending' : 'rejected')}</div>
                    </div>
                </div>

                <button class="btn btn-outline" onclick="setAuthStep('phone', false)" style="width: 100%; justify-content: center;">
                    <i class="fas fa-arrow-left"></i> Return to Main Login
                </button>
            </div>
        `;
    } else if (authStep === 'admin_password') {
        // --- SCREEN 6: Municipal Admin Secure Password Login ---
        cardContent = `
            <div style="text-align: center; margin-bottom: 1.5rem;">
                <div style="width: 56px; height: 56px; background: rgba(59, 130, 246, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 0.75rem auto;">
                    <i class="fas fa-user-shield" style="font-size: 1.8rem; color: var(--secondary);"></i>
                </div>
                <h2>Municipal Staff & Admin Portal</h2>
                <p>For authorized waste collectors and administrators</p>
            </div>

            ${errorHTML}

            <form onsubmit="handleAdminPasswordLogin(event)">
                <div class="form-group">
                    <label for="admin-login-username">Staff / Admin Username</label>
                    <div class="input-with-icon">
                        <i class="fas fa-id-badge input-icon"></i>
                        <input type="text" id="admin-login-username" class="form-control" placeholder="Enter username" required autofocus autocomplete="username">
                    </div>
                </div>

                <div class="form-group">
                    <label for="admin-login-password">Password</label>
                    <div class="input-with-icon">
                        <i class="fas fa-lock input-icon"></i>
                        <input type="password" id="admin-login-password" class="form-control" placeholder="Enter password" required autocomplete="current-password">
                    </div>
                </div>

                <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; margin-top: 0.5rem;" ${authLoading ? 'disabled' : ''}>
                    ${authLoading ? '<i class="fas fa-spinner fa-spin"></i> Authenticating...' : '<i class="fas fa-sign-in-alt"></i> Staff Login'}
                </button>

                <div style="margin-top: 1.25rem; text-align: center;">
                    <a href="javascript:void(0)" onclick="setAuthStep('phone', false)" style="font-size: 0.85rem; color: var(--text-muted); text-decoration: none;">
                        <i class="fas fa-mobile-alt"></i> Return to Phone Login
                    </a>
                </div>
            </form>
        `;
    }

    return `
        <div class="layout-center">
            <div class="login-card glass fade-in" style="max-width: 500px; width: 100%;">
                ${cardContent}
            </div>
        </div>
    `;
}

// ==============================================================================
// NAVIGATION BAR COMPONENT
// ==============================================================================

function renderNavbar(user) {
    const roleBadges = {
        'citizen': '<span class="badge" style="background:#ecfdf5;color:#059669;"><i class="fas fa-user"></i> Citizen</span>',
        'generator': '<span class="badge" style="background:#fef3c7;color:#d97706;"><i class="fas fa-industry"></i> Commercial Generator</span>',
        'admin': '<span class="badge" style="background:#eff6ff;color:#2563eb;"><i class="fas fa-shield-alt"></i> Municipal Admin</span>',
        'collector': '<span class="badge" style="background:#f3e8ff;color:#7e22ce;"><i class="fas fa-truck"></i> Waste Collector</span>'
    };

    return `
        <header class="navbar glass">
            <div class="nav-brand">
                <i class="fas fa-recycle brand-icon"></i>
                <span class="brand-text">EcoClean SWMS</span>
            </div>
            <div class="nav-user">
                <div class="user-info">
                    <span class="user-name">${user.name}</span>
                    <span class="user-role">${roleBadges[user.role] || user.role}</span>
                </div>
                <button class="btn btn-outline btn-sm" onclick="logout()" title="Logout of current session">
                    <i class="fas fa-sign-out-alt"></i> Logout
                </button>
            </div>
        </header>
    `;
}

// ==============================================================================
// CITIZEN DASHBOARD (PRESERVED)
// ==============================================================================

function renderCitizenDashboard() {
    let requestsHTML = '';
    if (currentRequests.length === 0) {
        requestsHTML = `
            <div class="empty-state">
                <i class="fas fa-trash-alt"></i>
                <p>No waste requests reported yet.</p>
            </div>
        `;
    } else {
        requestsHTML = '<div class="request-list">';
        currentRequests.forEach(req => {
            requestsHTML += `
                <div class="request-item">
                    <div class="request-info">
                        <h4>${req.type} Waste</h4>
                        <p><i class="fas fa-map-marker-alt"></i> ${req.location}</p>
                        <div class="request-meta">
                            <i class="fas fa-clock"></i> ${formatDate(req.date)}
                            ${req.collector ? ` &bull; <i class="fas fa-truck"></i> Collector: ${req.collector}` : ''}
                        </div>
                    </div>
                    <div class="request-actions">
                        ${getStatusBadge(req.status)}
                    </div>
                </div>
            `;
        });
        requestsHTML += '</div>';
    }

    return `
        <div class="layout-dashboard fade-in">
            ${renderNavbar(currentUser)}
            <div class="dashboard-content">
                <div class="dashboard-header">
                    <h2><i class="fas fa-home" style="color: var(--primary);"></i> Citizen Portal</h2>
                </div>
                
                <div class="grid-2">
                    <div class="card">
                        <div class="card-header">
                            <span class="card-title"><i class="fas fa-plus-circle" style="color: var(--primary);"></i> Report Waste</span>
                        </div>
                        <form onsubmit="submitRequest(event)">
                            <div class="form-group">
                                <label for="waste-type">Waste Category</label>
                                <select id="waste-type" class="form-control" required>
                                    <option value="" disabled selected>Select category</option>
                                    <option value="Household">Household Waste</option>
                                    <option value="Plastic">Plastic / Dry Recyclables</option>
                                    <option value="Organic">Organic / Food Waste</option>
                                    <option value="E-Waste">Electronic Waste</option>
                                    <option value="Hazardous">Hazardous / Chemical</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label for="waste-location">Pickup Location & Landmark</label>
                                <div class="input-with-icon">
                                    <i class="fas fa-map-pin input-icon"></i>
                                    <input type="text" id="waste-location" class="form-control" placeholder="Street, Ward, Landmark" required>
                                </div>
                            </div>
                            
                            <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center;">
                                <i class="fas fa-paper-plane"></i> Submit Waste Report
                            </button>
                        </form>
                    </div>
                    
                    <div class="card">
                        <div class="card-header">
                            <span class="card-title"><i class="fas fa-history" style="color: var(--secondary);"></i> My Reported Pickups</span>
                            <span class="badge badge-assigned">${currentRequests.length}</span>
                        </div>
                        ${requestsHTML}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ==============================================================================
// GENERATOR DASHBOARD (COMMERCIAL / BULK WASTE GENERATOR)
// ==============================================================================

function renderGeneratorDashboard() {
    let requestsHTML = '';
    if (currentRequests.length === 0) {
        requestsHTML = `
            <div class="empty-state">
                <i class="fas fa-dumpster"></i>
                <p>No bulk waste pickup requests scheduled yet.</p>
            </div>
        `;
    } else {
        requestsHTML = '<div class="request-list">';
        currentRequests.forEach(req => {
            requestsHTML += `
                <div class="request-item">
                    <div class="request-info">
                        <h4>${req.type} Bulk Waste</h4>
                        <p><i class="fas fa-map-marker-alt"></i> ${req.location}</p>
                        <div class="request-meta">
                            <i class="fas fa-calendar-alt"></i> ${formatDate(req.date)}
                            ${req.collector ? ` &bull; <i class="fas fa-truck"></i> Assigned Fleet: ${req.collector}` : ''}
                        </div>
                    </div>
                    <div class="request-actions">
                        ${getStatusBadge(req.status)}
                    </div>
                </div>
            `;
        });
        requestsHTML += '</div>';
    }

    return `
        <div class="layout-dashboard fade-in">
            ${renderNavbar(currentUser)}
            <div class="dashboard-content">
                <div class="dashboard-header">
                    <h2><i class="fas fa-industry" style="color: var(--status-pending);"></i> Generator Portal</h2>
                    <span class="badge" style="background:#ecfdf5;color:#059669;padding:0.4rem 0.8rem;">
                        <i class="fas fa-check-circle"></i> Verified Commercial Generator
                    </span>
                </div>

                <div class="grid-2">
                    <div class="card">
                        <div class="card-header">
                            <span class="card-title"><i class="fas fa-truck-loading" style="color: var(--primary);"></i> Schedule Bulk Waste Pickup</span>
                        </div>
                        <form onsubmit="submitRequest(event)">
                            <div class="form-group">
                                <label for="waste-type">Bulk Waste Classification</label>
                                <select id="waste-type" class="form-control" required>
                                    <option value="" disabled selected>Select waste stream</option>
                                    <option value="Commercial Organic">Commercial Bulk Organic</option>
                                    <option value="Industrial Dry/Plastic">Industrial Dry & Packaging Waste</option>
                                    <option value="Institutional E-Waste">Institutional Bulk E-Waste</option>
                                    <option value="Construction & Demolition">Construction & Demolition Debris</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label for="waste-location">Disposal Bay / Loading Dock Location</label>
                                <div class="input-with-icon">
                                    <i class="fas fa-building input-icon"></i>
                                    <input type="text" id="waste-location" class="form-control" placeholder="Facility Gate, Dock Number, Ward" required>
                                </div>
                            </div>
                            
                            <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center;">
                                <i class="fas fa-calendar-check"></i> Request Municipal Pickup
                            </button>
                        </form>
                    </div>

                    <div class="card">
                        <div class="card-header">
                            <span class="card-title"><i class="fas fa-list-alt" style="color: var(--secondary);"></i> Active Facility Disposals</span>
                            <span class="badge badge-assigned">${currentRequests.length}</span>
                        </div>
                        ${requestsHTML}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ==============================================================================
// ADMIN DASHBOARD (APPLICATIONS REVIEW + REQUESTS + COLLECTORS)
// ==============================================================================

function renderAdminDashboard() {
    const pendingRequests = currentRequests.filter(r => r.status === 'pending');
    const assignedRequests = currentRequests.filter(r => r.status !== 'pending');
    const pendingApps = generatorApplications.filter(a => a.status === 'pending');

    // Collector form
    let createCollectorHTML = '';
    if (showCreateCollector) {
        createCollectorHTML = `
            <div class="card fade-in" style="border-top: 4px solid var(--primary); margin-bottom: 1.5rem;">
                <div class="card-header">
                    <span class="card-title"><i class="fas fa-user-plus" style="color: var(--primary);"></i> Create Collector Account</span>
                    <button class="btn btn-outline btn-sm" onclick="toggleCreateCollector()"><i class="fas fa-times"></i> Cancel</button>
                </div>
                ${createCollectorError ? `<div class="auth-alert-error" style="margin-bottom:1rem;">${createCollectorError}</div>` : ''}
                <form onsubmit="handleCreateCollector(event)">
                    <div class="grid-2">
                        <div class="form-group">
                            <label>Full Name</label>
                            <input type="text" id="col-name" class="form-control" placeholder="Collector name" required>
                        </div>
                        <div class="form-group">
                            <label>Username</label>
                            <input type="text" id="col-username" class="form-control" placeholder="collector_username" required>
                        </div>
                        <div class="form-group">
                            <label>Phone</label>
                            <input type="tel" id="col-phone" class="form-control" placeholder="Phone number">
                        </div>
                        <div class="form-group">
                            <label>Password</label>
                            <input type="password" id="col-password" class="form-control" placeholder="Min 6 chars" required minlength="6">
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width:100%; justify-content:center;">
                        Create Collector Account
                    </button>
                </form>
            </div>
        `;
    }

    // Admin form
    let createAdminHTML = '';
    if (showCreateAdmin) {
        createAdminHTML = `
            <div class="card fade-in" style="border-top: 4px solid var(--status-pending); margin-bottom: 1.5rem;">
                <div class="card-header">
                    <span class="card-title"><i class="fas fa-user-shield" style="color: var(--status-pending);"></i> Create New Admin</span>
                    <button class="btn btn-outline btn-sm" onclick="toggleCreateAdmin()"><i class="fas fa-times"></i> Cancel</button>
                </div>
                ${createAdminError ? `<div class="auth-alert-error" style="margin-bottom:1rem;">${createAdminError}</div>` : ''}
                <form onsubmit="handleCreateAdmin(event)">
                    <div class="grid-2">
                        <div class="form-group">
                            <label>Full Name</label>
                            <input type="text" id="admin-new-name" class="form-control" placeholder="Admin name" required>
                        </div>
                        <div class="form-group">
                            <label>Username</label>
                            <input type="text" id="admin-new-username" class="form-control" placeholder="admin_username" required>
                        </div>
                        <div class="form-group">
                            <label>Phone</label>
                            <input type="tel" id="admin-new-phone" class="form-control" placeholder="Phone number">
                        </div>
                        <div class="form-group">
                            <label>Password</label>
                            <input type="password" id="admin-new-password" class="form-control" placeholder="Min 6 chars" required minlength="6">
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width:100%; justify-content:center;">
                        Create Administrator Account
                    </button>
                </form>
            </div>
        `;
    }

    // Tab content
    let tabContentHTML = '';

    if (adminTab === 'applications') {
        // --- Tab 1: Commercial Generator Applications ---
        if (generatorApplications.length === 0) {
            tabContentHTML = `
                <div class="card">
                    <div class="empty-state">
                        <i class="fas fa-clipboard-check"></i>
                        <p>No commercial waste generator applications submitted yet.</p>
                    </div>
                </div>
            `;
        } else {
            let rowsHTML = '';
            generatorApplications.forEach(app => {
                let actionButtons = '';
                if (app.status === 'pending') {
                    actionButtons = `
                        <div style="display:flex; gap:0.4rem;">
                            <button class="btn btn-primary btn-sm" onclick="handleReviewApplication(${app.id}, 'approve')" title="Approve application">
                                <i class="fas fa-check"></i> Approve
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="handleReviewApplication(${app.id}, 'reject')" style="border-color:#ef4444; color:#ef4444;" title="Reject application">
                                <i class="fas fa-times"></i> Reject
                            </button>
                        </div>
                    `;
                } else if (app.status === 'approved') {
                    actionButtons = `<span class="badge badge-completed"><i class="fas fa-check"></i> Approved</span>`;
                } else {
                    actionButtons = `<span class="badge" style="background:#fee2e2;color:#dc2626;"><i class="fas fa-times"></i> Rejected</span>`;
                }

                let docLink = app.has_document ? `
                    <a href="${API_BASE}/admin/generator-documents/${app.id}" target="_blank" class="btn btn-outline btn-sm" style="font-size:0.75rem;">
                        <i class="fas fa-file-alt"></i> View Doc
                    </a>
                ` : '<span style="color:var(--text-muted);font-size:0.8rem;">No file</span>';

                rowsHTML += `
                    <tr>
                        <td>
                            <strong>${app.business_name}</strong><br>
                            <small style="color:var(--text-muted);">${app.applicant_name}</small>
                        </td>
                        <td>
                            ${app.phone}<br>
                            <small style="color:var(--text-muted);">${app.email || 'N/A'}</small>
                        </td>
                        <td>
                            <span style="font-weight:500;">${app.id_type}</span><br>
                            <code>${app.id_number}</code>
                        </td>
                        <td>${app.address}</td>
                        <td>${docLink}</td>
                        <td>${getStatusBadge(app.status)}</td>
                        <td>${actionButtons}</td>
                    </tr>
                `;
            });

            tabContentHTML = `
                <div class="card">
                    <div class="card-header">
                        <span class="card-title"><i class="fas fa-file-signature" style="color:var(--primary);"></i> Generator Verification Requests</span>
                        <span class="badge badge-assigned">${generatorApplications.length} Total</span>
                    </div>
                    <div class="data-table-container">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>Business / Facility</th>
                                    <th>Contact</th>
                                    <th>Verification ID</th>
                                    <th>Facility Address</th>
                                    <th>Document</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHTML}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }
    } else if (adminTab === 'collectors') {
        // --- Tab 2: Registered Collectors ---
        let colRows = '';
        if (availableCollectors.length === 0) {
            colRows = `<div class="empty-state"><i class="fas fa-users"></i><p>No collectors registered yet.</p></div>`;
        } else {
            colRows = '<div class="request-list">';
            availableCollectors.forEach(c => {
                colRows += `
                    <div class="request-item">
                        <div class="request-info">
                            <h4><i class="fas fa-truck" style="color: var(--secondary); margin-right: 6px;"></i>${c.name}</h4>
                            <p style="font-size: 0.85rem; color: var(--text-muted);">
                                <i class="fas fa-at"></i> ${c.username}
                                ${c.phone ? `&bull; <i class="fas fa-phone"></i> ${c.phone}` : ''}
                            </p>
                        </div>
                        <div class="request-actions">
                            <span class="badge badge-assigned">Active Staff</span>
                        </div>
                    </div>
                `;
            });
            colRows += '</div>';
        }

        tabContentHTML = `
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><i class="fas fa-users" style="color:var(--secondary);"></i> Municipal Collector Directory</span>
                    <button class="btn btn-primary btn-sm" onclick="toggleCreateCollector()">
                        <i class="fas fa-user-plus"></i> Add Collector
                    </button>
                </div>
                ${colRows}
            </div>
        `;
    } else {
        // --- Tab 3: Requests & Tasks ---
        let pendingHTML = '';
        if (pendingRequests.length === 0) {
            pendingHTML = '<div class="empty-state"><p>No pending pickup requests.</p></div>';
        } else {
            pendingHTML = '<div class="request-list">';
            pendingRequests.forEach(req => {
                let options = '<option value="" disabled selected>Assign Collector</option>';
                availableCollectors.forEach(c => {
                    options += `<option value="${c.name}">${c.name}</option>`;
                });
                pendingHTML += `
                    <div class="request-item">
                        <div class="request-info">
                            <h4>${req.type} Waste</h4>
                            <p><i class="fas fa-map-marker-alt"></i> ${req.location}</p>
                            <div class="request-meta">
                                <i class="fas fa-user"></i> Citizen: ${req.citizen_name} &bull; 
                                <i class="fas fa-clock"></i> ${formatDate(req.date)}
                            </div>
                        </div>
                        <div class="request-actions">
                            <select class="form-control" style="width: auto; padding: 0.4rem 0.8rem;" onchange="assignCollector('${req.id}', this.value)">
                                ${options}
                            </select>
                        </div>
                    </div>
                `;
            });
            pendingHTML += '</div>';
        }

        let assignedHTML = '';
        if (assignedRequests.length === 0) {
            assignedHTML = '<div class="empty-state"><p>No assigned requests.</p></div>';
        } else {
            assignedHTML = '<div class="request-list">';
            assignedRequests.forEach(req => {
                assignedHTML += `
                    <div class="request-item">
                        <div class="request-info">
                            <h4>${req.type} Waste</h4>
                            <p><i class="fas fa-map-marker-alt"></i> ${req.location}</p>
                            <div class="request-meta">
                                <i class="fas fa-user"></i> ${req.citizen_name} &bull; 
                                <i class="fas fa-truck"></i> ${req.collector || 'Unassigned'}
                            </div>
                        </div>
                        <div class="request-actions">
                            ${getStatusBadge(req.status)}
                        </div>
                    </div>
                `;
            });
            assignedHTML += '</div>';
        }

        tabContentHTML = `
            <div class="grid-2">
                <div class="card" style="border-top: 4px solid var(--status-pending);">
                    <div class="card-header">
                        <span class="card-title"><i class="fas fa-hourglass-half"></i> Pending Requests</span>
                        <span class="badge badge-pending">${pendingRequests.length}</span>
                    </div>
                    ${pendingHTML}
                </div>
                
                <div class="card" style="border-top: 4px solid var(--status-assigned);">
                    <div class="card-header">
                        <span class="card-title"><i class="fas fa-tasks"></i> Assigned & Completed</span>
                        <span class="badge badge-assigned">${assignedRequests.length}</span>
                    </div>
                    ${assignedHTML}
                </div>
            </div>
        `;
    }

    return `
        <div class="layout-dashboard fade-in">
            ${renderNavbar(currentUser)}
            <div class="dashboard-content">
                <div class="dashboard-header" style="flex-wrap:wrap; gap:1rem;">
                    <h2><i class="fas fa-cogs" style="color: var(--primary);"></i> Admin Command Center</h2>
                    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn ${adminTab === 'requests' ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="setAdminTab('requests')">
                            <i class="fas fa-clipboard-list"></i> Waste Pickups (${pendingRequests.length})
                        </button>
                        <button class="btn ${adminTab === 'applications' ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="setAdminTab('applications')">
                            <i class="fas fa-industry"></i> Generator Applications ${pendingApps.length > 0 ? `<span class="badge badge-pending" style="margin-left:4px;">${pendingApps.length}</span>` : ''}
                        </button>
                        <button class="btn ${adminTab === 'collectors' ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="setAdminTab('collectors')">
                            <i class="fas fa-truck"></i> Collectors (${availableCollectors.length})
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="toggleCreateAdmin()" title="Add another administrator">
                            <i class="fas fa-user-shield"></i> Add Admin
                        </button>
                    </div>
                </div>

                ${createCollectorHTML}
                ${createAdminHTML}
                ${tabContentHTML}
            </div>
        </div>
    `;
}

// ==============================================================================
// COLLECTOR DASHBOARD — ROUTE & TASK MANAGEMENT
// ==============================================================================

function getWasteTypeIcon(type) {
    const icons = {
        'Household': 'fa-home',
        'Plastic': 'fa-recycle',
        'Organic': 'fa-leaf',
        'E-Waste': 'fa-microchip',
        'Hazardous': 'fa-skull-crossbones',
        'Commercial Organic': 'fa-boxes',
        'Industrial Dry/Plastic': 'fa-industry',
        'Institutional E-Waste': 'fa-server',
        'Construction & Demolition': 'fa-hard-hat',
    };
    for (const key of Object.keys(icons)) {
        if (type && type.toLowerCase().includes(key.toLowerCase())) return icons[key];
    }
    return 'fa-trash-alt';
}

function renderPriorityBadge(priority) {
    const labels = { low: 'Low', medium: 'Medium', high: 'High' };
    return `<span class="priority-badge priority-${priority || 'medium'}">${labels[priority] || 'Medium'}</span>`;
}

function buildTaskCard(req) {
    const icon = getWasteTypeIcon(req.type);
    const priorityBadge = renderPriorityBadge(req.priority);
    const reportedTime = formatDate(req.date);
    const startedTime = req.started_at ? formatDate(req.started_at) : null;
    const completedTime = req.completed_at ? formatDate(req.completed_at) : null;

    let actionButtons = '';
    if (req.status === 'assigned') {
        actionButtons = `
            <button class="btn btn-primary btn-sm" onclick="startTask('${req.id}')" style="flex:1; justify-content:center;">
                <i class="fas fa-play-circle"></i> Start Collection
            </button>
        `;
    } else if (req.status === 'in_progress') {
        actionButtons = `
            <button class="btn btn-primary btn-sm" onclick="completeRequest('${req.id}')" style="flex:1; justify-content:center; background:#10b981;">
                <i class="fas fa-check-circle"></i> Mark Complete
            </button>
        `;
    }

    const notesHTML = req.notes ? `
        <div class="task-card-notes">
            <i class="fas fa-sticky-note"></i> ${req.notes}
        </div>
    ` : '';

    return `
        <div class="task-card task-card--${req.status}">
            <div class="task-card-title">
                <span><i class="fas ${icon}" style="margin-right:6px; color:var(--primary);"></i>${req.type} Waste</span>
                ${priorityBadge}
            </div>
            <div class="task-card-location">
                <i class="fas fa-map-marker-alt" style="color:#ef4444;"></i>
                <strong>${req.location}</strong>
            </div>
            <div class="task-card-meta">
                <span><i class="fas fa-user"></i> ${req.citizen_name}</span>
                <span><i class="fas fa-clock"></i> ${reportedTime}</span>
                ${startedTime ? `<span><i class="fas fa-play"></i> Started: ${startedTime}</span>` : ''}
                ${completedTime ? `<span><i class="fas fa-check"></i> Done: ${completedTime}</span>` : ''}
            </div>
            ${notesHTML}
            ${actionButtons ? `<div class="task-card-actions">${actionButtons}</div>` : ''}
        </div>
    `;
}

function renderCollectorDashboard() {
    const assigned   = currentRequests.filter(r => r.status === 'assigned');
    const inProgress = currentRequests.filter(r => r.status === 'in_progress');
    const completed  = currentRequests.filter(r => r.status === 'completed');

    function buildColumn(title, icon, colClass, tasks, emptyMsg) {
        const cardsHTML = tasks.length > 0
            ? tasks.map(buildTaskCard).join('')
            : `<div class="kanban-empty"><i class="fas ${icon}"></i>${emptyMsg}</div>`;

        return `
            <div class="kanban-col kanban-col--${colClass}">
                <div class="kanban-col-header">
                    <span class="col-title">
                        <i class="fas ${icon}"></i> ${title}
                    </span>
                    <span class="col-count">${tasks.length}</span>
                </div>
                <div class="kanban-body">
                    ${cardsHTML}
                </div>
            </div>
        `;
    }

    const statsBar = `
        <div class="collector-stats-bar">
            <div class="stat-card">
                <div class="stat-icon stat-icon-assigned"><i class="fas fa-inbox"></i></div>
                <div class="stat-value">${collectorStats.assigned}</div>
                <div class="stat-label">Assigned</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon stat-icon-progress"><i class="fas fa-truck-moving"></i></div>
                <div class="stat-value">${collectorStats.in_progress}</div>
                <div class="stat-label">In Progress</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon stat-icon-today"><i class="fas fa-check-double"></i></div>
                <div class="stat-value">${collectorStats.completed_today}</div>
                <div class="stat-label">Done Today</div>
            </div>
            <div class="stat-card">
                <div class="stat-icon stat-icon-total"><i class="fas fa-chart-bar"></i></div>
                <div class="stat-value">${collectorStats.completed_total}</div>
                <div class="stat-label">Total Completed</div>
            </div>
        </div>
    `;

    const kanban = `
        <div class="collector-kanban">
            ${buildColumn('Assigned', 'fa-inbox', 'assigned', assigned, 'No new tasks assigned')}
            ${buildColumn('In Progress', 'fa-truck-moving', 'progress', inProgress, 'No tasks in progress')}
            ${buildColumn('Completed', 'fa-check-circle', 'completed', completed, 'No completed tasks yet')}
        </div>
    `;

    return `
        <div class="layout-dashboard fade-in">
            ${renderNavbar(currentUser)}
            <div class="dashboard-content">
                <div class="dashboard-header" style="flex-wrap:wrap; gap:1rem; margin-bottom:1.25rem;">
                    <div>
                        <h2><i class="fas fa-truck" style="color: var(--primary);"></i> My Task Board</h2>
                        <p style="margin-top:0.25rem; font-size:0.85rem;">
                            <i class="fas fa-sync-alt" style="color:var(--text-muted);"></i>
                            Auto-refreshes every 60s &bull; Last updated: ${new Date().toLocaleTimeString()}
                        </p>
                    </div>
                    <button class="btn btn-outline btn-sm" onclick="manualCollectorRefresh()" title="Refresh tasks now">
                        <i class="fas fa-sync-alt"></i> Refresh Now
                    </button>
                </div>
                ${statsBar}
                ${kanban}
            </div>
        </div>
    `;
}

async function manualCollectorRefresh() {
    await fetchData();
    renderApp();
    showNotification('Tasks refreshed');
}

// ==============================================================================
// APPLICATION CONTROLLER & INITIALIZATION
// ==============================================================================

function renderApp() {
    const appContainer = document.getElementById('app');
    if (!appContainer) return;
    
    if (!currentUser) {
        appContainer.innerHTML = renderLogin();
        return;
    }
    
    switch (currentUser.role) {
        case 'citizen':
            appContainer.innerHTML = renderCitizenDashboard();
            break;
        case 'generator':
            appContainer.innerHTML = renderGeneratorDashboard();
            break;
        case 'admin':
            appContainer.innerHTML = renderAdminDashboard();
            break;
        case 'collector':
            appContainer.innerHTML = renderCollectorDashboard();
            break;
        default:
            appContainer.innerHTML = renderLogin();
    }
}

// Initialize on page load with persistent session restoration
document.addEventListener('DOMContentLoaded', async () => {
    const token = getAuthToken();
    if (token) {
        try {
            const res = await fetch(`${API_BASE}/auth/me`, {
                headers: authHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                if (data.authenticated && data.user) {
                    currentUser = data.user;
                    await fetchData();
                } else {
                    localStorage.removeItem('swms_token');
                    currentUser = null;
                }
            } else {
                localStorage.removeItem('swms_token');
                currentUser = null;
            }
        } catch (e) {
            console.error('Session validation error:', e);
            localStorage.removeItem('swms_token');
            currentUser = null;
        }
    }
    renderApp();
    // Start auto-refresh if the restored session is a collector
    if (currentUser && currentUser.role === 'collector') {
        startCollectorAutoRefresh();
    }
});

