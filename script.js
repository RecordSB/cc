// MAIN JAVASCRIPT LOGIC (extracted and cleaned)

// ==========================================
// Configuration & State
// ==========================================
const WORKER_URL = "https://church-recorder-worker.tarstco.workers.dev";

let currentPassword = null;
let currentRole = null;
let currentJobId = null;
let statusInterval = null;
let countdownInterval = null;
let activeJobData = null;
let activeRecordingsMap = {}; // id -> recording data for active cards
let activeCountdownInterval = null;
let bufferStatusData = null;
let clipPollingInterval = null;
let bufferSectionOpen = false;

// ==========================================
// Login attempt / lockout helpers (localStorage)
// ==========================================
const ATTEMPTS_KEY = 'recordsb_failed_attempts';
const LOCK_KEY = 'recordsb_lockout_until';
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_THRESHOLD = 5; // after more than this many failures user will be locked out

function getFailedAttempts() {
	return parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0', 10) || 0;
}
function setFailedAttempts(n) {
	localStorage.setItem(ATTEMPTS_KEY, String(n));
}
function incrementFailedAttempts() {
	const n = getFailedAttempts() + 1;
	setFailedAttempts(n);
	return n;
}
function clearFailedAttempts() {
	localStorage.removeItem(ATTEMPTS_KEY);
	localStorage.removeItem(LOCK_KEY);
}
function getLockoutUntil() {
	return parseInt(localStorage.getItem(LOCK_KEY) || '0', 10) || 0;
}
function setLockoutUntil(ts) {
	localStorage.setItem(LOCK_KEY, String(ts));
}
function isLockedOut() {
	const until = getLockoutUntil();
	if (!until) return false;
	if (Date.now() >= until) { clearFailedAttempts(); return false; }
	return true;
}
function lockoutRemainingMs() {
	const until = getLockoutUntil();
	return Math.max(0, until - Date.now());
}
function formatLockoutTime(ms) {
	const mins = Math.ceil(ms / 60000);
	if (mins >= 60) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return `${h}h ${m}m`;
	}
	if (mins > 0) return `${mins}m`;
	return '<1m';
}
function showLockoutScreen(msRemaining) {
	const loginScreen = document.getElementById('login-screen');
	if (!loginScreen) return;
	loginScreen.innerHTML = `
		<div class="flex items-center justify-center min-h-screen">
			<div class="bg-white p-8 rounded-xl shadow-lg max-w-sm w-full text-center">
				<h2 class="text-xl font-bold text-red-700">Too Many Failed Attempts</h2>
				<p class="mt-4 text-sm text-gray-700">You have been locked out due to multiple incorrect password attempts.</p>
				<p class="mt-2 text-sm text-gray-500">Try again in ${formatLockoutTime(msRemaining)}.</p>
			</div>
		</div>
	`;
}

// ==========================================
// Initialization
// ==========================================
document.addEventListener("DOMContentLoaded", () => {

	// If the URL contains the timeout marker, show a distinct message on the login screen
	if (window.location.href && window.location.href.includes('something-went-wrong')) {
		const loginErr = document.getElementById('login-error');
		if (loginErr) {
			loginErr.textContent = 'Something went wrong while connecting — please try again.';
			loginErr.classList.remove('hidden');
		}
	}

	// If locked out via localStorage, show lockout screen and stop initializing
	if (isLockedOut()) {
		showLockoutScreen(lockoutRemainingMs());
		return;
	}
	// Attempt silent auto-login from sessionStorage before showing login screen
	const savedPassword = sessionStorage.getItem('recordsb_password');
	if (savedPassword) {
		(async () => {
			try {
				currentPassword = savedPassword;
				const recRes = await apiCall("/recordings");
				if (!recRes.ok) throw new Error("Saved password rejected");
				const logRes = await apiCall("/logs?limit=1");
				if (logRes.status === 200) currentRole = "admin";
				else if (logRes.status === 403) currentRole = "user";
				else throw new Error("Unexpected role response");
				showMainApp();
				return;
			} catch (e) {
				// Saved password is stale or server unreachable — fall through to login screen
				currentPassword = null;
				sessionStorage.removeItem('recordsb_password');
			}
		})();
	}

	const loginForm = document.getElementById("login-form");
	if (loginForm) loginForm.addEventListener("submit", handleLogin);

	const navRecordings = document.getElementById("nav-recordings");
	if (navRecordings) navRecordings.addEventListener("click", () => switchTab('recordings'));
	const navAdmin = document.getElementById("nav-admin");
	if (navAdmin) navAdmin.addEventListener("click", () => switchTab('admin'));

	const scheduleForm = document.getElementById("schedule-form");
	if (scheduleForm) scheduleForm.addEventListener("submit", handleScheduleRecording);

	const durationInput = document.getElementById("duration");
	if (durationInput) durationInput.addEventListener("input", updateDurationHelper);

	const startNowCheckbox = document.getElementById("start-now");
	if (startNowCheckbox) {
		startNowCheckbox.addEventListener("change", (e) => {
			const timeInput = document.getElementById("start-time");
			if (!timeInput) return;
			timeInput.disabled = e.target.checked;
			if (e.target.checked) timeInput.value = '';
		});
	}

	const cancelBtn = document.getElementById('btn-cancel-recording');
	// per-card cancel handlers are attached dynamically; keep legacy element removal if present
	if (cancelBtn) cancelBtn.addEventListener('click', cancelRecording);

	// enforce recording-name rules: spaces -> '-', no leading/trailing space or dash
	const recordingNameInput = document.getElementById('recording-name');
	if (recordingNameInput) {
		recordingNameInput.addEventListener('keydown', (e) => {
			if (e.key === ' ') {
				// prevent space; insert '_' unless at start
				e.preventDefault();
				const el = e.target;
				const pos = el.selectionStart || 0;
				if (pos === 0) return; // don't insert at start
				const val = el.value || '';
				// insert '_' at cursor
				const newVal = val.slice(0,pos) + '_' + val.slice(pos);
				el.value = newVal;
				el.setSelectionRange(pos+1, pos+1);
			}
		});

		recordingNameInput.addEventListener('input', (e) => {
			let v = e.target.value || '';
				// remove leading/trailing spaces and underscores
				v = v.replace(/^[_\s]+|[_\s]+$/g, '');
				// collapse multiple spaces/underscores into single underscore
				v = v.replace(/[\s_]+/g, '_');
			e.target.value = v;
		});
	}

	const btnRefreshLogs = document.getElementById('btn-refresh-logs');
	if (btnRefreshLogs) btnRefreshLogs.addEventListener('click', loadLogs);
	const logFilter = document.getElementById('log-filter');
	if (logFilter) logFilter.addEventListener('change', loadLogs);

	updateDurationHelper();

	const clipStartInput = document.getElementById('clip-start');
	if (clipStartInput) {
		clipStartInput.addEventListener('input', () => {
			updateClipTimeHelper();
			checkGapWarning();
		});
	}
	const clipDurationInput = document.getElementById('clip-duration');
	if (clipDurationInput) {
		clipDurationInput.addEventListener('input', checkGapWarning);
	}
});

// ==========================================
// API Helper
// ==========================================
async function apiCall(endpoint, method = "GET", body = null) {
	const headers = { "Content-Type": "application/json" };
	if (currentPassword) headers["X-Password"] = currentPassword;

	const options = { method, headers };
	if (body) options.body = JSON.stringify(body);

	const response = await fetch(`${WORKER_URL}${endpoint}`, options);

	if (!response.ok && response.status !== 401 && response.status !== 403) {
		let errorMsg = response.statusText || "Request failed";
		try {
			const errData = await response.json();
			if (errData && errData.error) errorMsg = errData.error;
		} catch (e) {}
		throw new Error(errorMsg);
	}

	return response;
}

// ==========================================
// Authentication
// ==========================================
async function handleLogin(e) {
	e.preventDefault();
	const pwdInput = document.getElementById("password").value;
	const errorEl = document.getElementById("login-error");
	const submitBtn = document.getElementById("login-submit");

	if (errorEl) errorEl.classList.add("hidden");
	if (submitBtn) {
		submitBtn.disabled = true;
		submitBtn.textContent = "Logging in...";
	}

	let loginFinished = false;
	const loginTimeout = setTimeout(() => {
		if (!loginFinished) {
			// append marker to URL and reload
			const marker = 'something-went-wrong';
			if (!window.location.href.includes(marker)) {
				window.location.href = window.location.href + (window.location.hash ? '' : '') + '#' + marker;
			} else {
				window.location.reload();
			}
		}
	}, 10000);

	try {
		currentPassword = pwdInput;

		const recRes = await apiCall("/recordings");
		if (recRes.status === 401) {
			// Backend indicates wrong password — increment local failure counter
			currentPassword = null;
			const attempts = incrementFailedAttempts();
			// remaining attempts before lockout (lockout occurs after > LOCK_THRESHOLD)
			const remaining = (LOCK_THRESHOLD + 1) - attempts;
			if (attempts > LOCK_THRESHOLD) {
				// lock out for 24 hours
				setLockoutUntil(Date.now() + LOCK_DURATION_MS);
				loginFinished = true;
				clearTimeout(loginTimeout);
				showLockoutScreen(lockoutRemainingMs());
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Log In"; }
				return;
			} else {
				if (attempts >= 2 && attempts <= LOCK_THRESHOLD) {
					if (errorEl) {
						errorEl.textContent = `${remaining} password attempts left.`;
						errorEl.classList.remove('hidden');
					}
				} else {
					if (errorEl) {
						errorEl.textContent = 'Incorrect password. Please try again.';
						errorEl.classList.remove('hidden');
					}
				}
				loginFinished = true;
				clearTimeout(loginTimeout);
				if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Log In"; }
				return;
			}
		}
		if (!recRes.ok) throw new Error("Failed to authenticate with the server.");

		const logRes = await apiCall("/logs?limit=1");
		if (logRes.status === 200) {
			currentRole = "admin";
		} else if (logRes.status === 403) {
			currentRole = "user";
		} else {
			throw new Error("Unexpected role verification response.");
		}

		// successful authentication — reset local failed-attempts state
		clearFailedAttempts();

		// Persist password for the session so editor.html and live.html don't require re-login
		sessionStorage.setItem('recordsb_password', pwdInput);

		showMainApp();

		loginFinished = true;
		clearTimeout(loginTimeout);
	} catch (error) {
		currentPassword = null;
		if (errorEl) {
			errorEl.textContent = error.message || String(error);
			errorEl.classList.remove("hidden");
		}
	} finally {
		loginFinished = true;
		clearTimeout(loginTimeout);
		if (submitBtn) {
			submitBtn.disabled = false;
			submitBtn.textContent = "Log In";
		}
	}
}

// ==========================================
// Main App & Navigation
// ==========================================
function showMainApp() {
	const loginScreen = document.getElementById("login-screen");
	const mainApp = document.getElementById("main-app");
	if (loginScreen) loginScreen.classList.add("hidden");
	if (mainApp) mainApp.classList.remove("hidden");

	const mainNav = document.getElementById("main-nav");
	const navAdmin = document.getElementById("nav-admin");
	if (currentRole === "admin") {
		if (mainNav) mainNav.classList.remove("hidden");
		if (navAdmin) {
			navAdmin.classList.remove("hidden");
			navAdmin.classList.add("inline-block");
		}
	} else {
		// hide the entire recordings/admin switcher for non-admin users
		if (mainNav) mainNav.classList.add("hidden");
	}

	switchTab('recordings');
	loadRecordings();
}

function switchTab(tabId) {
	const recTab = document.getElementById("tab-recordings");
	const adminTab = document.getElementById("tab-admin");
	if (recTab) recTab.classList.toggle("hidden", tabId !== 'recordings');
	if (adminTab) adminTab.classList.toggle("hidden", tabId !== 'admin');

	const navRec = document.getElementById("nav-recordings");
	const navAdmin = document.getElementById("nav-admin");
	if (navRec) {
		if (tabId === 'recordings') {
			navRec.classList.add("bg-white", "shadow", "text-gray-900");
			navRec.classList.remove("text-gray-600");
			if (navAdmin) { navAdmin.classList.remove("bg-white", "shadow", "text-gray-900"); navAdmin.classList.add("text-gray-600"); }
		} else {
			navRec.classList.remove("bg-white", "shadow", "text-gray-900");
			navRec.classList.add("text-gray-600");
		}
	}
	if (navAdmin) {
		if (tabId === 'admin') {
			navAdmin.classList.add("bg-white", "shadow", "text-gray-900");
			navAdmin.classList.remove("text-gray-600");
			if (navRec) { navRec.classList.remove("bg-white", "shadow", "text-gray-900"); navRec.classList.add("text-gray-600"); }
		} else {
			navAdmin.classList.remove("bg-white", "shadow", "text-gray-900");
			navAdmin.classList.add("text-gray-600");
		}
	}

	if (tabId === 'admin') {
		loadLogs();
		loadAdminRecordings();
	}
}

// ==========================================
// Buffer / Clip Recovery
// ==========================================

function toggleBufferSection() {
	const section = document.getElementById('buffer-section');
	const chevron = document.getElementById('buffer-chevron');
	if (!section) return;
	bufferSectionOpen = !bufferSectionOpen;
	section.classList.toggle('hidden', !bufferSectionOpen);
	if (chevron) chevron.style.transform = bufferSectionOpen ? 'rotate(180deg)' : '';
	if (bufferSectionOpen) loadBufferStatus();
}

async function loadBufferStatus() {
	const dotEl = document.getElementById('buffer-status-dot');
	const textEl = document.getElementById('buffer-status-text');
	const submitBtn = document.getElementById('clip-submit');
	const formInputIds = ['clip-recording-name', 'clip-start', 'clip-duration'];

	try {
		const res = await apiCall('/buffer/status');
		if (!res.ok) throw new Error('Failed to fetch buffer status');
		const data = await res.json();
		bufferStatusData = data;

		const running = data.running === true;
		const hoursAvail = data.hours_available || 0;

		if (dotEl) {
			dotEl.className = `inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${running ? 'bg-green-500' : 'bg-red-500'}`;
		}
		if (textEl) {
			if (running) {
				const h = Math.floor(hoursAvail);
				const m = Math.round((hoursAvail - h) * 60);
				const parts = [];
				if (h > 0) parts.push(`${h}h`);
				if (m > 0 || h === 0) parts.push(`${m}m`);
				textEl.textContent = `Buffer active — last ${parts.join(' ')} available`;
				textEl.className = 'text-sm text-green-700 font-medium';
			} else {
				textEl.textContent = 'Buffer offline — clips unavailable';
				textEl.className = 'text-sm text-red-600 font-medium';
			}
		}

		if (submitBtn) submitBtn.disabled = !running;
		formInputIds.forEach(id => {
			const el = document.getElementById(id);
			if (el) el.disabled = !running;
		});

	} catch (e) {
		if (dotEl) dotEl.className = 'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 bg-gray-400';
		if (textEl) { textEl.textContent = 'Could not reach buffer status'; textEl.className = 'text-sm text-gray-500'; }
	}
}

function updateClipTimeHelper() {
	const startEl = document.getElementById('clip-start');
	const helperEl = document.getElementById('clip-start-helper');
	if (!startEl || !helperEl) return;
	const mins = parseInt(startEl.value, 10);
	if (isNaN(mins) || mins <= 0) { helperEl.textContent = ''; return; }

	const wallTime = new Date(Date.now() - mins * 60000);
	const now = new Date();
	const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
	const isToday = wallTime.toDateString() === now.toDateString();
	const isYesterday = wallTime.toDateString() === yesterday.toDateString();

	const timeStr = wallTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	let label;
	if (isToday) label = `${timeStr} today`;
	else if (isYesterday) label = `${timeStr} yesterday`;
	else label = wallTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	helperEl.textContent = `= ${label}`;
}

function checkGapWarning() {
	const warningEl = document.getElementById('buffer-gap-warning');
	if (!warningEl || !bufferStatusData) return;

	const startMins = parseInt((document.getElementById('clip-start') || {}).value, 10);
	const durMins = parseInt((document.getElementById('clip-duration') || {}).value, 10);
	if (isNaN(startMins) || isNaN(durMins) || startMins <= 0 || durMins <= 0) {
		warningEl.classList.add('hidden');
		return;
	}

	const clipStart = new Date(Date.now() - startMins * 60000);
	const clipEnd = new Date(clipStart.getTime() + durMins * 60000);
	const gaps = bufferStatusData.gaps || [];

	const overlaps = gaps.some(gap => {
		try {
			return new Date(gap.start) < clipEnd && new Date(gap.end) > clipStart;
		} catch (e) { return false; }
	});

	warningEl.classList.toggle('hidden', !overlaps);
}

async function handleClipSubmit() {
	const errorEl = document.getElementById('buffer-clip-error');
	if (errorEl) errorEl.classList.add('hidden');

	const recordingName = ((document.getElementById('clip-recording-name') || {}).value || '').trim();
	const startMins = parseInt((document.getElementById('clip-start') || {}).value, 10);
	const durMins = parseInt((document.getElementById('clip-duration') || {}).value, 10);

	if (!recordingName) return showClipError('Recording name cannot be empty.');
	if (isNaN(startMins) || startMins <= 0) return showClipError('Start time must be a positive number of minutes.');
	if (isNaN(durMins) || durMins < 1 || durMins > 180) return showClipError('Duration must be between 1 and 180 minutes.');

	const hoursAvail = bufferStatusData ? (bufferStatusData.hours_available || 0) : 0;
	const minsAvail = Math.floor(hoursAvail * 60);
	if (startMins > minsAvail) return showClipError(`Start time exceeds available buffer (${minsAvail} minutes available).`);
	if (startMins - durMins < 0) return showClipError('Clip would extend into the future — reduce duration or start further back.');

	const submitBtn = document.getElementById('clip-submit');
	if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }

	try {
		const res = await apiCall('/buffer/clip', 'POST', {
			recording_name: recordingName,
			start_minutes_ago: startMins,
			duration_minutes: durMins
		});
		const data = await res.json();

		if (!res.ok) {
			showClipError(data.error || 'Failed to submit clip request.');
			return;
		}

		// Clear form
		['clip-recording-name', 'clip-start', 'clip-duration'].forEach(id => {
			const el = document.getElementById(id); if (el) el.value = '';
		});
		const helperEl = document.getElementById('clip-start-helper'); if (helperEl) helperEl.textContent = '';
		const gapEl = document.getElementById('buffer-gap-warning'); if (gapEl) gapEl.classList.add('hidden');

		loadRecordings();
		pollClipUntilDone(data.job_id);

	} catch (e) {
		showClipError(e.message || 'Request failed.');
	} finally {
		if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Extract Clip'; }
	}
}

function showClipError(msg) {
	const el = document.getElementById('buffer-clip-error');
	if (!el) return;
	el.textContent = msg;
	el.classList.remove('hidden');
}

async function pollClipUntilDone(jobId) {
	if (clipPollingInterval) clearInterval(clipPollingInterval);
	let attempts = 0;
	clipPollingInterval = setInterval(async () => {
		attempts++;
		try {
			const res = await apiCall(`/status/${jobId}`);
			if (!res.ok) return;
			const data = await res.json();
			const status = (data.status || '').toLowerCase();
			loadRecordings();
			if (['done', 'error', 'cancelled'].includes(status) || attempts >= 60) {
				clearInterval(clipPollingInterval);
				clipPollingInterval = null;
			}
		} catch (e) {
			console.error('Clip polling error:', e);
		}
	}, 5000);
}

// ==========================================
// Scheduling Recordings
// ==========================================
function updateDurationHelper() {
	const el = document.getElementById("duration");
	const helper = document.getElementById("duration-helper");
	if (!el || !helper) return;
	const mins = parseInt(el.value, 10);
	if (isNaN(mins) || mins <= 0) { helper.textContent = ""; return; }
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	const parts = [];
	if (hours > 0) parts.push(`${hours} hr${hours > 1 ? 's' : ''}`);
	if (remainingMins > 0 || hours === 0) parts.push(`${remainingMins} min${remainingMins !== 1 ? 's' : ''}`);
	helper.textContent = `(~ ${parts.join(' ')})`;
}

async function handleScheduleRecording(e) {
	e.preventDefault();
	const errorEl = document.getElementById("schedule-error");
	if (errorEl) errorEl.classList.add("hidden");

	const recordingName = (document.getElementById("recording-name") || {}).value || "";
	const sessionName = recordingName; // Session name mirrors recording name implicitly
	const duration = parseInt((document.getElementById("duration") || {}).value, 10);
	const startNow = !!(document.getElementById("start-now") && document.getElementById("start-now").checked);
	const startTimeInput = (document.getElementById("start-time") || {}).value || "";

	if (!recordingName.trim()) return showScheduleError("Recording name cannot be empty.");
	if (isNaN(duration) || duration <= 0) return showScheduleError("Please enter a valid duration in minutes.");

	let startTime;
	if (startNow) startTime = new Date().toISOString();
	else {
		if (!startTimeInput) return showScheduleError("Please select a start time or check 'Start immediately'.");
		startTime = new Date(startTimeInput).toISOString();
		if (new Date(startTime) < new Date()) return showScheduleError("Start time cannot be in the past.");
	}

	const payload = {
		session_name: sessionName.trim(),
		recording_name: recordingName.trim(),
		start_time: startTime,
		duration_minutes: duration
	};

	const submitBtn = document.getElementById("schedule-submit");
	if (submitBtn) submitBtn.disabled = true;

	try {
		const res = await apiCall("/record", "POST", payload);
		if (!res.ok) throw new Error("Failed to schedule recording");
		const data = await res.json();

		const form = document.getElementById("schedule-form"); if (form) form.reset();
		const helper = document.getElementById("duration-helper"); if (helper) helper.textContent = "";
		const timeInput = document.getElementById("start-time"); if (timeInput) timeInput.disabled = false;

		// refresh list to show any active recordings (including this new job)
		loadRecordings();

	} catch (error) {
		showScheduleError(error.message || String(error));
	} finally {
		if (submitBtn) submitBtn.disabled = false;
	}
}

function showScheduleError(msg) {
	const el = document.getElementById("schedule-error");
	if (!el) return;
	el.textContent = msg;
	el.classList.remove("hidden");
}

// ==========================================
// Status & Polling Logic
// ==========================================
const SVGS = {
    pending: `<svg class="h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
    recording: `<div class="relative"><svg class="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" /></svg><span class="absolute -top-1 -right-1 flex h-3 w-3"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span></span></div>`,
    spinner: (color) => `<svg class="animate-spin h-8 w-8 ${color}" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`,
    done: `<svg class="h-8 w-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
    error: `<svg class="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`,
    unknown: `<svg class="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" /></svg>`
};

function startPolling(jobId) {
	// Legacy single-job polling retained for compatibility but not used for multiple cards.
	currentJobId = jobId;
	if (statusInterval) clearInterval(statusInterval);
	statusInterval = setInterval(fetchStatus, 15000);
}

function stopPolling() {
	if (statusInterval) clearInterval(statusInterval);
	if (activeCountdownInterval) clearInterval(activeCountdownInterval);
	statusInterval = null;
	activeCountdownInterval = null;
	activeJobData = null;
	currentJobId = null;
	activeRecordingsMap = {};
	loadRecordings();
}

async function fetchStatus() {
	if (!currentJobId) return;
	try {
		const res = await apiCall(`/status/${currentJobId}`);
		if (!res.ok) throw new Error("Failed to fetch status");
		const data = await res.json();

		activeJobData = data;
		updateStatusCardData(data);

		const s = (data.status || '').toString().toLowerCase();
		if (['done','error','cancelled','canceled'].includes(s)) stopPolling();
	} catch (e) {
		console.error("Status polling error:", e);
	}
}

	function updateStatusCardData(data) {
    // Note: This function only runs if using the legacy single #status-card approach
	const nameEl = document.getElementById("status-name"); if (nameEl) nameEl.textContent = data.recordingName || data.recording_name || "Unknown Recording";

	const iconEl = document.getElementById("status-icon");
	const labelEl = document.getElementById("status-label");
	const downloadBtn = document.getElementById("btn-status-download");
	const cancelBtn = document.getElementById("btn-cancel-recording");
	const errorText = document.getElementById("status-error-text");
	const progressContainer = document.getElementById("status-progress-container");

	const status = (data.status || '').toString().toLowerCase();

	if (downloadBtn) {
		downloadBtn.classList.add("hidden");
		downloadBtn.style.display = "none";
	}
	if (cancelBtn) cancelBtn.classList.add("hidden");
	if (errorText) errorText.classList.add("hidden");
	if (progressContainer) progressContainer.classList.add("hidden");
	if (iconEl) iconEl.className = "status-icon flex-shrink-0 w-12 h-12 flex items-center justify-center";

	switch(status) {
		case 'pending':
			if (iconEl) iconEl.innerHTML = SVGS.pending;
			if (labelEl) { labelEl.textContent = "Pending"; labelEl.className = "font-medium text-gray-800"; }
			if (cancelBtn) cancelBtn.classList.remove("hidden");
			break;
		case 'recording':
			if (iconEl) iconEl.innerHTML = SVGS.recording;
			if (labelEl) { labelEl.textContent = "Recording Live"; labelEl.className = "font-medium text-red-700"; }
			if (cancelBtn) cancelBtn.classList.remove("hidden");
			if (progressContainer) progressContainer.classList.remove("hidden");
			break;
		case 'uploading':
			if (iconEl) iconEl.innerHTML = SVGS.spinner('text-blue-500');
			if (labelEl) { labelEl.textContent = "Uploading to Storage"; labelEl.className = "font-medium text-blue-700"; }
			break;
		case 'done':
			if (iconEl) iconEl.innerHTML = SVGS.done;
			if (labelEl) { labelEl.textContent = "Done"; labelEl.className = "font-medium text-green-700"; }
			const dl = data.downloadUrl || data.download_url;
			if (dl && downloadBtn) {
				downloadBtn.href = '#';
				downloadBtn.onclick = (ev) => { ev.preventDefault(); downloadRecording(data.id || data.jobId, data.recording_name || data.recordingName); };
				downloadBtn.style.display = ""; // remove inline none
				downloadBtn.classList.remove("hidden");
			}
			break;
		case 'error':
			if (iconEl) iconEl.innerHTML = SVGS.error;
			if (labelEl) { labelEl.textContent = "Error"; labelEl.className = "font-medium text-red-700"; }
			if (errorText) { errorText.textContent = data.errorMessage || data.error || "An unknown error occurred."; errorText.classList.remove("hidden"); }
			break;
		default:
			if (iconEl) iconEl.innerHTML = SVGS.unknown;
			if (labelEl) labelEl.textContent = status;
	}

	updateCountdownUI();
}

// ==========================================
// Multiple Active Status Cards
// ==========================================
function renderActiveStatusCards(recordings) {
	const container = document.getElementById('status-cards');
	const template = document.getElementById('status-card-template');
	if (!container || !template) return;
	const activeStatuses = ['pending','recording','uploading','clipping','rendering'];
	const activeRecs = recordings.filter(r => activeStatuses.includes(((r.status||'')+"").toLowerCase()));

	container.innerHTML = '';
	activeRecordingsMap = {};

	if (!activeRecs || activeRecs.length === 0) {
		container.classList.add('hidden');
		if (activeCountdownInterval) { clearInterval(activeCountdownInterval); activeCountdownInterval = null; }
		return;
	}

	activeRecs.forEach(rec => {
		const node = template.content.cloneNode(true);
		const section = node.querySelector('section');
		const id = rec.id || rec.jobId;
		if (!id) return;
		section.setAttribute('data-job-id', id);
		section.setAttribute('data-start-time', rec.startTime || rec.start_time || rec.created_at || '');
		section.setAttribute('data-duration-minutes', (rec.durationMinutes || rec.duration_minutes || 0));

		// Find structural elements
		const nameEl = node.querySelector('.status-name');
		const iconEl = node.querySelector('.status-icon');
		const labelEl = node.querySelector('.status-label');
		
		// --------------------------------------------------------------------------------------
		// FIX: Completely REMOVE the download button from the DOM for active cards.
		// Because the index.html template uses Tailwind responsive classes (sm:inline-block),
		// simply adding `.hidden` fails on desktop. Removing it guarantees it cannot appear.
		// --------------------------------------------------------------------------------------
		const downloadElements = node.querySelectorAll('.btn-download, a, button');
		downloadElements.forEach(el => {
			const text = (el.textContent || '').toLowerCase();
			const cls = (el.className || '').toString().toLowerCase();
			if (text.includes('download') || cls.includes('download')) {
				el.remove(); 
			}
		});

		// --------------------------------------------------------------------------------------
		// FIX: Correctly control the Cancel Button's display without fighting Tailwind
		// --------------------------------------------------------------------------------------
		let cancelEl = node.querySelector('.btn-cancel');
		if (!cancelEl) {
			const allBtns = node.querySelectorAll('button, a');
			for (let i = 0; i < allBtns.length; i++) {
				if ((allBtns[i].textContent || '').toLowerCase().includes('cancel')) {
					cancelEl = allBtns[i]; break;
				}
			}
		}

		if (cancelEl) {
            // Strip Tailwind display classes that cause weird responsive behavior
            cancelEl.classList.remove('hidden', 'sm:inline-block', 'inline-block');
            cancelEl.style.display = 'none'; // hidden by default
			cancelEl.addEventListener('click', () => cancelRecordingFor(id));
		}

		const errorEl = node.querySelector('.status-error-text');
		if (errorEl) errorEl.classList.add('hidden');

		const progressContainer = node.querySelector('.status-progress-container');
		if (progressContainer) progressContainer.classList.add('hidden');

		if (nameEl) nameEl.textContent = rec.recordingName || rec.recording_name || '';
		const status = ((rec.status||'')+"").toLowerCase();

		// Set visuals based on status
		if (status === 'pending') {
			if (iconEl) iconEl.innerHTML = SVGS.pending;
			if (labelEl) labelEl.textContent = 'Pending';
			if (cancelEl) cancelEl.style.display = 'inline-block'; // force show using inline CSS
		} else if (status === 'recording') {
			if (iconEl) iconEl.innerHTML = SVGS.recording;
			if (labelEl) { labelEl.textContent = 'Recording Live'; labelEl.classList.add('text-red-700'); }
			if (cancelEl) cancelEl.style.display = 'inline-block'; // force show using inline CSS
			if (progressContainer) progressContainer.classList.remove('hidden');
		} else if (status === 'uploading') {
			if (iconEl) iconEl.innerHTML = SVGS.spinner('text-blue-500');
			if (labelEl) labelEl.textContent = 'Uploading to Storage';
			// cancelEl stays hidden
		} else if (status === 'clipping') {
			if (iconEl) iconEl.innerHTML = SVGS.spinner('text-purple-600');
			if (labelEl) { labelEl.textContent = 'Extracting Clip'; labelEl.classList.add('text-purple-700'); }
		} else if (status === 'rendering') {
			if (iconEl) iconEl.innerHTML = SVGS.spinner('text-yellow-600');
			if (labelEl) { labelEl.textContent = 'Rendering'; labelEl.classList.add('text-yellow-700'); }
		}

		container.appendChild(node);
		activeRecordingsMap[id] = rec;
	});

	container.classList.remove('hidden');

	if (activeCountdownInterval) clearInterval(activeCountdownInterval);
	activeCountdownInterval = setInterval(updateAllCountdowns, 1000);
	updateAllCountdowns();
}

function updateAllCountdowns() {
	const now = Date.now();
	Object.keys(activeRecordingsMap).forEach(id => {
		const rec = activeRecordingsMap[id];
		const section = document.querySelector(`[data-job-id="${id}"]`);
		if (!section) return;
		const timerEl = section.querySelector('.status-timer');
		const progressBar = section.querySelector('.status-progress-bar');
		const progressContainer = section.querySelector('.status-progress-container');

		const startTime = new Date(rec.startTime || rec.start_time || rec.created_at).getTime();
		const durationMs = (rec.durationMinutes || rec.duration_minutes || 0) * 60 * 1000;
		const endTime = startTime + durationMs;
		const status = ((rec.status||'')+"").toLowerCase();

		if (status === 'pending') {
			const diff = startTime - now;
			timerEl.textContent = diff > 0 ? `• Starts in: ${formatTimeDiff(diff)}` : '• Starting momentarily...';
		} else if (status === 'recording') {
			const diff = endTime - now;
			if (diff > 0) {
				timerEl.textContent = `• Remaining: ${formatTimeDiff(diff)}`;
				if (progressBar && durationMs > 0) {
					const percent = Math.min(100, Math.max(0, ((now - startTime) / durationMs) * 100));
					progressBar.style.width = `${percent}%`;
					progressContainer.classList.remove('hidden');
				}
			} else {
				timerEl.textContent = '• Finishing up...';
				if (progressBar) progressBar.style.width = '100%';
			}
		} else {
			timerEl.textContent = '';
		}
	});
}

async function cancelRecordingFor(id) {
	if (!id) return;
	if (!confirm('Are you sure you want to cancel this recording?')) return;
	try {
		const res = await apiCall(`/cancel/${id}`, 'POST');
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.error || 'Failed to cancel recording');
		}
		// refresh
		loadRecordings();
	} catch (e) { alert('Error cancelling: ' + e.message); }
}

async function cancelRecording() {
	if (!currentJobId) return;
	if (!confirm("Are you sure you want to cancel this recording?")) return;

	try {
		const res = await apiCall(`/cancel/${currentJobId}`, "POST");
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.error || 'Failed to cancel recording');
		}

		stopPolling();
		const statusCard = document.getElementById("status-card"); if (statusCard) statusCard.classList.add("hidden");
		loadRecordings();
	} catch (e) {
		alert("Error cancelling: " + e.message);
	}
}

// ==========================================
// Recordings List
// ==========================================
async function loadRecordings() {
	try {
		const res = await apiCall("/recordings");
		if (!res.ok) throw new Error("Failed to fetch recordings");
		let recordings = await res.json();

		recordings.sort((a,b) => new Date(b.created_at || b.startTime || b.start_time) - new Date(a.created_at || a.startTime || a.start_time));

		// Render any active recordings in the status area, and show only past recordings below
		renderActiveStatusCards(recordings);

		const listEl = document.getElementById("recordings-list");
		if (!listEl) return;
		listEl.innerHTML = "";

		const activeStatuses = ['pending','recording','uploading','clipping','rendering'];
		const pastRecordings = recordings.filter(r => !activeStatuses.includes(((r.status||'')+"").toLowerCase()));

		if (!pastRecordings || pastRecordings.length === 0) {
			listEl.innerHTML = "<p class='text-gray-500 text-sm py-4 text-center'>No past recordings found.</p>";
			return;
		}

		pastRecordings.forEach(rec => {
			const div = document.createElement("div");
			div.className = "py-4 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center";

			const status = (rec.status || '').toString().toLowerCase();
			const isDeleted = ['deleted','removed','canceled','cancelled'].includes(status) || rec.deleted === true || rec.isDeleted === true;

			let actionButtonsHtml = "";
			const canDownload = status === 'done' && (rec.download_url || rec.downloadUrl);
			if (canDownload && !isDeleted) {
				const id = rec.id || rec.jobId;
				actionButtonsHtml = `
					<a href="#" onclick="watchRecording('${id}'); return false;" class="inline-flex items-center px-3 py-1.5 border border-blue-300 text-xs font-medium rounded shadow-sm text-blue-700 bg-white hover:bg-blue-50">Watch</a>
					<a href="#" onclick="downloadRecording('${id}', '${escapeHtml(rec.recording_name || rec.recordingName || '')}'); return false;" class="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white bg-blue-600 hover:bg-blue-700">Download</a>
				`;
			}

			const createdAt = rec.created_at || rec.startTime || rec.start_time;
			let autodeleteHtml = '';
			if (!isDeleted && createdAt) {
				const createdMs = new Date(createdAt).getTime();
				const ttl = 30 * 24 * 60 * 60 * 1000;
				const remaining = (createdMs + ttl) - Date.now();
				let autodeleteText = '';
				if (remaining <= 0) {
					autodeleteText = '0d';
				} else {
					const dayMs = 24 * 3600 * 1000;
					const hourMs = 3600 * 1000;
					if (remaining >= dayMs) {
						// Never round up days — use floor
						const days = Math.floor(remaining / dayMs);
						autodeleteText = `${days}d`;
					} else if (remaining >= hourMs) {
						// Show hours when less than a day
						const hours = Math.floor(remaining / hourMs);
						autodeleteText = `${hours}h`;
					} else {
						// Less than 1 hour
						autodeleteText = '<1hr';
					}
				}
				autodeleteHtml = ` <span>&bull;</span> <span class="text-xs text-gray-500">deletes in ${autodeleteText}</span>`;
			}

			div.innerHTML = `
				<div class="flex-1 min-w-0 pr-4">
					<h4 class="text-sm font-medium text-gray-900 truncate">
						${escapeHtml(rec.recording_name || rec.recordingName || '')}
						${rec.job_type === 'clip' ? '<span class="ml-1.5 badge badge-clip">Buffer Clip</span>' : ''}
					</h4>
					<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
						<span>${createdAt ? new Date(createdAt).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : ''}</span>
						<span>&bull;</span>
						<span>${rec.duration_minutes || rec.durationMinutes || '-'} min</span>
						<span>&bull;</span>
						<span class="badge badge-${(status||'')}">${escapeHtml(rec.status || '')}</span>
						${autodeleteHtml}
					</div>
					<p class="text-xs text-gray-500 mt-1">Downloads: ${escapeHtml(String(rec.download_count || rec.downloadCount || 0))}</p>
				</div>
				<div class="recording-actions w-full sm:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:flex-shrink-0">
					${actionButtonsHtml}
				</div>
			`;

			listEl.appendChild(div);
		});

	} catch (e) {
		console.error("Load recordings error:", e);
		const el = document.getElementById("recordings-list"); if (el) el.innerHTML = "<p class='text-red-500 text-sm py-4 text-center'>Failed to load recordings.</p>";
	}
}

// ==========================================
// Admin Functionality
// ==========================================
async function loadLogs() {
	if (currentRole !== 'admin') return;
	const filterVal = (document.getElementById("log-filter") || {}).value || 'all';
	const tbody = document.getElementById("log-table-body");
	if (!tbody) return;
	tbody.innerHTML = "<tr><td colspan='4' class='px-6 py-4 text-center text-sm text-gray-500'>Loading logs...</td></tr>";

	try {
		const res = await apiCall("/logs?limit=200");
		if (!res.ok) throw new Error("Failed to load logs");
		let logs = await res.json();

		updateAdminStats(logs);

		if (filterVal !== 'all') logs = logs.filter(l => ((l.level||'info').toLowerCase()) === filterVal);

		tbody.innerHTML = '';
		if (!logs || logs.length === 0) {
			tbody.innerHTML = "<tr><td colspan='4' class='px-6 py-4 text-center text-sm text-gray-500'>No logs found.</td></tr>";
			return;
		}

		logs.forEach(log => {
			const tr = document.createElement('tr');
			const level = (log.level || 'info').toLowerCase();
			const badgeClass = getBadgeClassForLevel(level);
			let details = log.details || {};
			let detailsText = typeof details === 'string' ? details : JSON.stringify(details);
			if (log.event === 'record_finish' && details.fileSize) detailsText = `Size: ${details.fileSize}`;
			if (log.event === 'login_fail') detailsText = `Wrong password attempt`;

			tr.innerHTML = `
				<td class="px-6 py-4 whitespace-nowrap text-xs text-gray-500">${new Date(log.timestamp).toLocaleString()}</td>
				<td class="px-6 py-4 whitespace-nowrap"><span class="badge ${badgeClass}">${escapeHtml(log.event || level)}</span></td>
				<td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(log.role || 'system')}</td>
				<td class="px-6 py-4 text-sm text-gray-500 truncate max-w-xs" title="${escapeHtml(detailsText)}">${escapeHtml(detailsText)}</td>
			`;
			tbody.appendChild(tr);
		});

	} catch (e) {
		tbody.innerHTML = `<tr><td colspan='4' class="px-6 py-4 text-center text-sm text-red-500">Failed to load logs: ${e.message}</td></tr>`;
	}
}

async function loadAdminRecordings() {
	if (currentRole !== 'admin') return;
	try {
		const res = await apiCall('/recordings');
		if (!res.ok) throw new Error('Failed to load recordings');
		let recordings = await res.json();
		recordings.sort((a,b) => new Date(b.startTime || b.start_time) - new Date(a.startTime || a.start_time));

		const listEl = document.getElementById('admin-recordings-list');
		if (!listEl) return; listEl.innerHTML = '';

		if (!recordings || recordings.length === 0) {
			listEl.innerHTML = "<p class='text-gray-500 text-sm py-4 text-center'>No storage items found.</p>";
			return;
		}

		recordings.forEach(rec => {
			const status = (rec.status || '').toString().toLowerCase();
			
			const hideDeleteBtn = ['deleted', 'removed', 'canceled', 'cancelled', 'uploading', 'clipping', 'rendering'].includes(status) || rec.deleted === true || rec.isDeleted === true;
			const canWatch = status === 'done' && !hideDeleteBtn;

			const div = document.createElement('div');
			div.className = 'py-3 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center';
			const watchBtnHtml = canWatch ? `<a href="#" onclick="watchRecording('${rec.id || rec.jobId}'); return false;" class="inline-flex items-center justify-center px-2.5 py-1.5 border border-blue-300 shadow-sm text-xs font-medium rounded text-blue-700 bg-white hover:bg-blue-50">Watch</a>` : '';
			const deleteBtnHtml = hideDeleteBtn ? '' : `<button class="inline-flex items-center justify-center px-2.5 py-1.5 border border-red-300 shadow-sm text-xs font-medium rounded text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500" onclick="window.deleteRecording('${rec.id || rec.jobId}')">Delete</button>`;

			div.innerHTML = `
				<div class="flex-1 min-w-0 pr-4">
					<p class="text-sm font-medium text-gray-900 truncate">
						${escapeHtml(rec.recordingName || rec.recording_name || '')}
						${rec.job_type === 'clip' ? '<span class="ml-1.5 badge badge-clip">Buffer Clip</span>' : ''}
					</p>
					<p class="text-xs text-gray-500 mt-1">ID: ${rec.id || rec.jobId} &bull; ${escapeHtml(rec.status || '')}</p>
					<p class="text-xs text-gray-500 mt-1">Downloads: ${escapeHtml(String(rec.download_count || rec.downloadCount || 0))}</p>
				</div>
				<div class="recording-actions w-full sm:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:flex-shrink-0">
					${watchBtnHtml}${deleteBtnHtml}
				</div>
			`;

			listEl.appendChild(div);
		});

	} catch (e) {
		const el = document.getElementById('admin-recordings-list'); if (el) el.innerHTML = "<p class='text-red-500 text-sm py-4 text-center'>Error loading storage management.</p>";
	}
}

function updateAdminStats(logs) {
	apiCall('/recordings').then(res => res.json()).then(recordings => {
		const total = recordings.length || 0;
		const currentMonth = new Date().getMonth();
		const currentYear = new Date().getFullYear();
		const thisMonth = recordings.filter(r => { const d = new Date(r.startTime || r.start_time || r.created_at); return d.getMonth() === currentMonth && d.getFullYear() === currentYear; }).length;
		const active = recordings.filter(r => ['recording','pending','uploading'].includes(((r.status||'')+"").toLowerCase())).length;
		const elTotal = document.getElementById('stat-total'); if (elTotal) elTotal.textContent = total;
		const elMonth = document.getElementById('stat-month'); if (elMonth) elMonth.textContent = thisMonth;
		const elActive = document.getElementById('stat-active'); if (elActive) elActive.textContent = active > 0 ? active + ' Job(s)' : 'None';
	}).catch(e => console.error('Stats error', e));
}

window.deleteRecording = async function(id) {
	if (!confirm("This will permanently delete the file from storage. Are you sure?")) return;
	try {
		const res = await apiCall(`/recordings/${id}`, 'DELETE');
		if (!res.ok) throw new Error('Delete failed');
		loadAdminRecordings(); loadRecordings();
	} catch (e) { alert('Error deleting recording: ' + e.message); }
};

// ==========================================
// Utility Formatters
// ==========================================
function formatTimeDiff(ms) {
	const totalSecs = Math.floor(ms / 1000);
	const h = Math.floor(totalSecs / 3600);
	const m = Math.floor((totalSecs % 3600) / 60);
	const s = totalSecs % 60;
	return [h, m, s].map(v => v < 10 ? '0' + v : v).filter((v, i) => v !== '00' || i > 0).join(':');
}

function getBadgeClassForLevel(level) {
	switch(level) {
		case 'success': return 'badge-success';
		case 'error': return 'badge-danger';
		case 'warning': return 'badge-warning';
		default: return 'badge-info';
	}
}

function escapeHtml(unsafe) {
	if (unsafe === null || unsafe === undefined) return '';
	return unsafe.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

window.downloadRecording = async function(id, suggestedName) {
    if (!id) return alert('Missing recording id');
    try {
        const res = await apiCall(`/download/${id}`);
        if (!res.ok) {
            let msg = 'Download failed';
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch(e) {}
            alert('Download failed: ' + msg);
            return;
        }
        const data = await res.json();
        if (!data.url) { alert('Failed to get download URL'); return; }

        // Navigate to the presigned URL — R2 returns Content-Disposition: attachment
        // so the browser downloads the file without leaving the page, on all devices
        window.location.href = data.url;

    } catch (e) {
        console.error('Download error', e);
        alert('Download failed: ' + (e.message || e));
    }
};

window.watchRecording = async function(id) {
    if (!id) return alert('Missing recording id');
    try {
        const res = await apiCall(`/watch/${id}`);
        if (!res.ok) {
            let msg = 'Watch failed';
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch(e) {}
            alert('Watch failed: ' + msg);
            return;
        }
        const data = await res.json();
        if (!data.url) { alert('Failed to get watch URL'); return; }
        window.open(data.url, '_blank');
    } catch (e) {
        console.error('Watch error', e);
        alert('Watch failed: ' + (e.message || e));
    }
};
