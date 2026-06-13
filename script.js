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

	const sessionName = (document.getElementById("session-name") || {}).value || "";
	const recordingName = (document.getElementById("recording-name") || {}).value || "";
	const duration = parseInt((document.getElementById("duration") || {}).value, 10);
	const startNow = !!(document.getElementById("start-now") && document.getElementById("start-now").checked);
	const startTimeInput = (document.getElementById("start-time") || {}).value || "";

	if (!sessionName.trim() || !recordingName.trim()) return showScheduleError("Names cannot be empty.");
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
	if (iconEl) iconEl.className = "text-4xl w-12 h-12 flex items-center justify-center";

	switch(status) {
		case 'pending':
			if (iconEl) iconEl.innerHTML = "⏳";
			if (labelEl) { labelEl.textContent = "Pending"; labelEl.className = "font-medium text-gray-800"; }
			if (cancelBtn) cancelBtn.classList.remove("hidden");
			break;
		case 'recording':
			if (iconEl) { iconEl.innerHTML = "🔴"; iconEl.classList.add("pulse"); }
			if (labelEl) { labelEl.textContent = "Recording Live"; labelEl.className = "font-medium text-red-700"; }
			if (cancelBtn) cancelBtn.classList.remove("hidden");
			if (progressContainer) progressContainer.classList.remove("hidden");
			break;
		case 'uploading':
			if (iconEl) { iconEl.innerHTML = "🔄"; iconEl.classList.add("spin"); }
			if (labelEl) { labelEl.textContent = "Uploading to Storage"; labelEl.className = "font-medium text-blue-700"; }
			break;
		case 'done':
			if (iconEl) iconEl.innerHTML = "✅";
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
			if (iconEl) iconEl.innerHTML = "❌";
			if (labelEl) { labelEl.textContent = "Error"; labelEl.className = "font-medium text-red-700"; }
			if (errorText) { errorText.textContent = data.errorMessage || data.error || "An unknown error occurred."; errorText.classList.remove("hidden"); }
			break;
		default:
			if (iconEl) iconEl.innerHTML = "❓";
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
	const activeStatuses = ['pending','recording','uploading'];
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
			if (iconEl) iconEl.textContent = '⏳';
			if (labelEl) labelEl.textContent = 'Pending';
			if (cancelEl) cancelEl.style.display = 'inline-block'; // force show using inline CSS
		} else if (status === 'recording') {
			if (iconEl) { iconEl.textContent = '🔴'; iconEl.classList.add('pulse'); }
			if (labelEl) { labelEl.textContent = 'Recording Live'; labelEl.classList.add('text-red-700'); }
			if (cancelEl) cancelEl.style.display = 'inline-block'; // force show using inline CSS
			if (progressContainer) progressContainer.classList.remove('hidden');
		} else if (status === 'uploading') {
			if (iconEl) { iconEl.textContent = '🔄'; iconEl.classList.add('spin'); }
			if (labelEl) labelEl.textContent = 'Uploading to Storage';
            // cancelEl stays hidden
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

		const activeStatuses = ['pending','recording','uploading'];
		const pastRecordings = recordings.filter(r => !activeStatuses.includes(((r.status||'')+"").toLowerCase()));

		if (!pastRecordings || pastRecordings.length === 0) {
			listEl.innerHTML = "<p class='text-gray-500 text-sm py-4 text-center'>No past recordings found.</p>";
			return;
		}

		pastRecordings.forEach(rec => {
			const div = document.createElement("div");
			div.className = "py-4 flex justify-between items-center";

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
					<h4 class="text-sm font-medium text-gray-900 truncate">${escapeHtml(rec.recording_name || rec.recordingName || '')}</h4>
					<div class="mt-1 flex items-center space-x-2 text-xs text-gray-500">
						<span>${createdAt ? new Date(createdAt).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : ''}</span>
						<span>&bull;</span>
						<span>${rec.duration_minutes || rec.durationMinutes || '-'} min</span>
						<span>&bull;</span>
						<span class="badge badge-${(status||'')}">${escapeHtml(rec.status || '')}</span>
						${autodeleteHtml}
					</div>
					<p class="text-xs text-gray-500 mt-1">Downloads: ${escapeHtml(String(rec.download_count || rec.downloadCount || 0))}</p>
				</div>
				<div class="flex-shrink-0 flex items-center gap-2">
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
			
			const hideDeleteBtn = ['deleted', 'removed', 'canceled', 'cancelled', 'uploading'].includes(status) || rec.deleted === true || rec.isDeleted === true;
			const canWatch = status === 'done' && !hideDeleteBtn;

			const div = document.createElement('div');
			div.className = 'py-3 flex justify-between items-center';
			const watchBtnHtml = canWatch ? `<a href="#" onclick="watchRecording('${rec.id || rec.jobId}'); return false;" class="ml-2 inline-flex items-center px-2.5 py-1.5 border border-blue-300 shadow-sm text-xs font-medium rounded text-blue-700 bg-white hover:bg-blue-50">Watch</a>` : '';
			const deleteBtnHtml = hideDeleteBtn ? '' : `<button class="ml-2 inline-flex items-center px-2.5 py-1.5 border border-red-300 shadow-sm text-xs font-medium rounded text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500" onclick="window.deleteRecording('${rec.id || rec.jobId}')">Delete</button>`;

			div.innerHTML = `
				<div class="flex-1 min-w-0 pr-4">
					<p class="text-sm font-medium text-gray-900 truncate">${escapeHtml(rec.recordingName || rec.recording_name || '')}</p>
					<p class="text-xs text-gray-500 mt-1">ID: ${rec.id || rec.jobId} &bull; ${escapeHtml(rec.status || '')}</p>
					<p class="text-xs text-gray-500 mt-1">Downloads: ${escapeHtml(String(rec.download_count || rec.downloadCount || 0))}</p>
				</div>
				<div class="flex items-center flex-shrink-0">
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
