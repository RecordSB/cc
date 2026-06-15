// ==========================================
// Config & State
// ==========================================
const WORKER_URL = "https://church-recorder-worker.tarstco.workers.dev";

let currentPassword = null;
let currentJobId = null;
let videoDuration = 0;
let inPoint = 0;
let outPoint = 0;
let isDragging = null; // 'in' | 'out' | 'seek' | null
let renderJobId = null;
let renderPollInterval = null;

// ==========================================
// Auth
// ==========================================
function checkAuth() {
    const saved = sessionStorage.getItem('recordsb_password');
    if (!saved) {
        window.location.href = 'index.html';
        return false;
    }
    currentPassword = saved;
    return true;
}

// ==========================================
// API Helper
// ==========================================
async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (currentPassword) headers['X-Password'] = currentPassword;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${WORKER_URL}${endpoint}`, opts);
    if (res.status === 401) {
        sessionStorage.removeItem('recordsb_password');
        window.location.href = 'index.html';
        throw new Error('Session expired');
    }
    return res;
}

// ==========================================
// Time Utilities
// ==========================================
function formatTime(s) {
    if (isNaN(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatTimeFull(s) {
    // Always H:MM:SS for inputs and clip length display
    if (isNaN(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function parseTime(str) {
    if (!str) return null;
    const parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==========================================
// File Selection
// ==========================================
async function loadRecordingsList() {
    const listEl = document.getElementById('recording-select-list');
    if (!listEl) return;

    try {
        const res = await apiCall('/recordings');
        if (!res.ok) throw new Error('Failed to load recordings');
        const recordings = await res.json();
        const done = recordings.filter(r => r.status === 'done');

        if (done.length === 0) {
            listEl.innerHTML = "<p class='text-gray-500 text-sm py-8 text-center'>No completed recordings available to edit.</p>";
            return;
        }

        listEl.innerHTML = '';
        done.forEach(rec => {
            const div = document.createElement('div');
            div.className = 'flex items-center justify-between p-4 hover:bg-gray-50 transition-colors';

            const createdAt = rec.created_at || rec.start_time;
            const dateStr = createdAt ? new Date(createdAt).toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit'
            }) : '';
            const durStr = rec.duration_minutes ? `${rec.duration_minutes} min` : '—';
            const badge = rec.job_type === 'clip'
                ? ' <span class="badge badge-clip">Buffer Clip</span>'
                : rec.job_type === 'render'
                ? ' <span class="badge badge-rendering">Render</span>'
                : '';

            div.innerHTML = `
                <div class="min-w-0 flex-1 pr-4">
                    <p class="text-sm font-medium text-gray-900 truncate">
                        ${escapeHtml(rec.recording_name || '')}${badge}
                    </p>
                    <p class="text-xs text-gray-500 mt-0.5">
                        ${escapeHtml(dateStr)} · ${escapeHtml(durStr)}
                    </p>
                </div>
                <button onclick="openInEditor('${rec.id}')"
                    class="flex-shrink-0 inline-flex items-center px-3 py-1.5 border border-blue-300 text-blue-700 text-xs font-medium rounded-md hover:bg-blue-50 transition-colors">
                    Open in Editor
                </button>
            `;
            listEl.appendChild(div);
        });

    } catch (e) {
        listEl.innerHTML = `<p class='text-red-500 text-sm py-8 text-center'>Failed to load: ${escapeHtml(e.message)}</p>`;
    }
}

async function openInEditor(jobId) {
    currentJobId = jobId;
    videoDuration = 0;
    inPoint = 0;
    outPoint = 0;

    // Switch views
    document.getElementById('view-select').classList.add('hidden');
    document.getElementById('view-editor').classList.remove('hidden');

    // Reset video loading state
    const loadingEl = document.getElementById('video-loading');
    const loadingIcon = document.getElementById('video-loading-icon');
    const loadingText = document.getElementById('video-loading-text');
    loadingEl.classList.remove('hidden');
    loadingIcon.textContent = '⚙️';
    loadingIcon.className = 'text-4xl mb-3 spin inline-block';
    loadingText.textContent = 'Loading video...';

    // Disable render until metadata loads
    document.getElementById('render-btn').disabled = true;
    document.getElementById('editor-filename').classList.add('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
        // Fetch watch URL and recording name in parallel
        const [watchRes, statusRes] = await Promise.all([
            apiCall(`/watch/${jobId}`),
            apiCall(`/status/${jobId}`)
        ]);

        if (!watchRes.ok) throw new Error('Could not get video URL');
        const watchData = await watchRes.json();

        if (statusRes.ok) {
            const statusData = await statusRes.json();
            const nameEl = document.getElementById('editor-filename');
            nameEl.textContent = statusData.recording_name || '';
            nameEl.classList.remove('hidden');
        }

        const video = document.getElementById('editor-video');
        video.src = watchData.url;
        video.load();

    } catch (e) {
        loadingIcon.textContent = '❌';
        loadingIcon.className = 'text-4xl mb-3 inline-block';
        loadingText.textContent = `Failed to load video: ${e.message}`;
    }
}

function backToSelection() {
    const video = document.getElementById('editor-video');
    if (video) { video.pause(); video.src = ''; }

    currentJobId = null;
    videoDuration = 0;

    document.getElementById('view-editor').classList.add('hidden');
    document.getElementById('view-select').classList.remove('hidden');
    document.getElementById('editor-filename').classList.add('hidden');
    document.getElementById('render-btn').disabled = true;
}

// ==========================================
// Video Events & Playback
// ==========================================
function initVideoEvents() {
    const video = document.getElementById('editor-video');
    if (!video) return;

    video.addEventListener('loadedmetadata', () => {
        videoDuration = video.duration;
        inPoint = 0;
        outPoint = videoDuration;

        document.getElementById('video-loading').classList.add('hidden');
        document.getElementById('render-btn').disabled = false;
        document.getElementById('time-total').textContent = formatTime(videoDuration);
        document.getElementById('tl-end').textContent = formatTime(videoDuration);
        document.getElementById('tl-mid').textContent = formatTime(videoDuration / 2);

        syncInputsFromPoints();
        redrawTimeline();

        // Push forward 0.1 seconds to avoid displaying a black frame initially
        if (videoDuration > 0.1) {
            video.currentTime = 0.1;
        }
    });

    video.addEventListener('timeupdate', () => {
        const t = video.currentTime;
        document.getElementById('time-current').textContent = formatTime(t);
        if (videoDuration > 0) {
            document.getElementById('timeline-playhead').style.left =
                `${(t / videoDuration) * 100}%`;
        }
    });

    video.addEventListener('play', () => {
        document.getElementById('btn-play').textContent = '⏸';
    });
    video.addEventListener('pause', () => {
        document.getElementById('btn-play').textContent = '▶';
    });
    video.addEventListener('ended', () => {
        document.getElementById('btn-play').textContent = '▶';
    });

    video.addEventListener('error', () => {
        const icon = document.getElementById('video-loading-icon');
        const text = document.getElementById('video-loading-text');
        document.getElementById('video-loading').classList.remove('hidden');
        icon.textContent = '❌';
        icon.className = 'text-4xl mb-3 inline-block';
        text.textContent = 'Failed to load video. Try going back and re-opening.';
    });
}

function togglePlay() {
    const video = document.getElementById('editor-video');
    if (!video || !videoDuration) return;
    video.paused ? video.play() : video.pause();
}

function skipTime(delta) {
    const video = document.getElementById('editor-video');
    if (!video || !videoDuration) return;
    video.currentTime = Math.max(0, Math.min(videoDuration, video.currentTime + delta));
}

function setInPoint() {
    const video = document.getElementById('editor-video');
    if (!video || !videoDuration) return;
    inPoint = Math.max(0, Math.min(video.currentTime, outPoint - 1));
    syncInputsFromPoints();
    redrawTimeline();
}

function setOutPoint() {
    const video = document.getElementById('editor-video');
    if (!video || !videoDuration) return;
    outPoint = Math.min(videoDuration, Math.max(video.currentTime, inPoint + 1));
    syncInputsFromPoints();
    redrawTimeline();
}

function jumpToIn() {
    const video = document.getElementById('editor-video');
    if (video) video.currentTime = inPoint;
}

function jumpToOut() {
    const video = document.getElementById('editor-video');
    if (video) video.currentTime = outPoint;
}

function selectAll() {
    if (!videoDuration) return;
    inPoint = 0;
    outPoint = videoDuration;
    syncInputsFromPoints();
    redrawTimeline();
}

// ==========================================
// Timeline & Drag Handles
// ==========================================
function redrawTimeline() {
    if (!videoDuration) return;
    const inPct = (inPoint / videoDuration) * 100;
    const outPct = (outPoint / videoDuration) * 100;

    document.getElementById('timeline-fill').style.left = `${inPct}%`;
    document.getElementById('timeline-fill').style.width = `${outPct - inPct}%`;
    document.getElementById('handle-in').style.left = `${inPct}%`;
    document.getElementById('handle-out').style.left = `${outPct}%`;
    document.getElementById('clip-duration-display').textContent =
        formatTimeFull(outPoint - inPoint);
}

function getTimeFromEvent(e, track) {
    const rect = track.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX
                  : e.changedTouches ? e.changedTouches[0].clientX
                  : e.clientX;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return pct * videoDuration;
}

function initTimeline() {
    const track = document.getElementById('timeline-track');
    const handleIn = document.getElementById('handle-in');
    const handleOut = document.getElementById('handle-out');
    if (!track || !handleIn || !handleOut) return;

    // Drag start on IN handle
    const startDrag = (which) => (e) => {
        if (!videoDuration) return;
        e.preventDefault();
        e.stopPropagation();
        isDragging = which;
    };
    handleIn.addEventListener('mousedown', startDrag('in'));
    handleIn.addEventListener('touchstart', startDrag('in'), { passive: false });
    handleOut.addEventListener('mousedown', startDrag('out'));
    handleOut.addEventListener('touchstart', startDrag('out'), { passive: false });

    // Click on track background = seek
    track.addEventListener('mousedown', (e) => {
        if (!videoDuration) return;
        if (handleIn.contains(e.target) || handleOut.contains(e.target)) return;
        isDragging = 'seek';
        const video = document.getElementById('editor-video');
        if (video) video.currentTime = getTimeFromEvent(e, track);
    });

    // Document-level move so drag continues even if pointer leaves the track
    const onMove = (e) => {
        if (!isDragging || !videoDuration) return;
        if (e.cancelable) e.preventDefault();
        const t = getTimeFromEvent(e, track);

        if (isDragging === 'in') {
            inPoint = Math.max(0, Math.min(t, outPoint - 1));
            syncInputsFromPoints();
            redrawTimeline();
        } else if (isDragging === 'out') {
            outPoint = Math.min(videoDuration, Math.max(t, inPoint + 1));
            syncInputsFromPoints();
            redrawTimeline();
        } else if (isDragging === 'seek') {
            const video = document.getElementById('editor-video');
            if (video) video.currentTime = Math.max(0, Math.min(t, videoDuration));
        }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });

    const onEnd = () => { isDragging = null; };
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
}

// ==========================================
// Time Inputs (manual entry)
// ==========================================
function syncInputsFromPoints() {
    document.getElementById('input-start').value = formatTimeFull(inPoint);
    document.getElementById('input-end').value = formatTimeFull(outPoint);
    document.getElementById('clip-duration-display').textContent =
        formatTimeFull(outPoint - inPoint);
}

function initTimeInputs() {
    document.getElementById('input-start').addEventListener('change', (e) => {
        const t = parseTime(e.target.value);
        if (t === null || isNaN(t) || t < 0) {
            e.target.value = formatTimeFull(inPoint);
            return;
        }
        inPoint = Math.max(0, Math.min(t, videoDuration > 0 ? outPoint - 1 : 0));
        syncInputsFromPoints();
        redrawTimeline();
    });

    document.getElementById('input-end').addEventListener('change', (e) => {
        const t = parseTime(e.target.value);
        if (t === null || isNaN(t)) {
            e.target.value = formatTimeFull(outPoint);
            return;
        }
        outPoint = Math.min(videoDuration || 0, Math.max(t, inPoint + 1));
        syncInputsFromPoints();
        redrawTimeline();
    });
}

// ==========================================
// Render Modal
// ==========================================
function showModalState(state) {
    ['choose', 'loading', 'done', 'error'].forEach(s => {
        document.getElementById(`render-modal-${s}`)
            .classList.toggle('hidden', s !== state);
    });
}

function openRenderModal() {
    if (!currentJobId || !videoDuration) return;
    if (outPoint - inPoint < 1) {
        alert('Select at least 1 second between IN and OUT points.');
        return;
    }
    showModalState('choose');
    document.getElementById('render-modal').classList.remove('hidden');
}

function closeRenderModal() {
    document.getElementById('render-modal').classList.add('hidden');
    if (renderPollInterval) {
        clearInterval(renderPollInterval);
        renderPollInterval = null;
    }
}

async function startRender(exportType) {
    showModalState('loading');
    document.getElementById('render-modal-status').textContent = 'Submitting to server...';

    try {
        const res = await apiCall('/render', 'POST', {
            source_job_id: currentJobId,
            start_seconds: parseFloat(inPoint.toFixed(3)),
            end_seconds: parseFloat(outPoint.toFixed(3)),
            export_type: exportType
        });
        const data = await res.json();
        if (!res.ok) {
            showRenderError(data.error || 'Render request failed');
            return;
        }
        renderJobId = data.job_id;
        pollRenderJob();

    } catch (e) {
        showRenderError(e.message || 'Network error');
    }
}

function pollRenderJob() {
    if (renderPollInterval) clearInterval(renderPollInterval);
    let attempts = 0;

    renderPollInterval = setInterval(async () => {
        attempts++;
        if (attempts > 120) { // 6-minute safety cap at 3s interval
            clearInterval(renderPollInterval);
            showRenderError('Render timed out — please try again');
            return;
        }
        try {
            const res = await apiCall(`/status/${renderJobId}`);
            if (!res.ok) return;
            const data = await res.json();
            const status = (data.status || '').toLowerCase();

            const statusEl = document.getElementById('render-modal-status');
            if (status === 'rendering') statusEl.textContent = 'Server is processing your clip...';
            else if (status === 'uploading') statusEl.textContent = 'Uploading to storage...';

            if (status === 'done') {
                clearInterval(renderPollInterval);
                renderPollInterval = null;
                await triggerDownloadAndCleanup(renderJobId);
            } else if (status === 'error') {
                clearInterval(renderPollInterval);
                renderPollInterval = null;
                showRenderError(data.error_message || 'Render failed on server');
            }
        } catch (e) {
            console.error('Render poll error:', e);
        }
    }, 3000);
}

async function triggerDownloadAndCleanup(jobId) {
    try {
        const res = await apiCall(`/download/${jobId}`);
        if (!res.ok) throw new Error('Failed to get download URL');
        const data = await res.json();

        showModalState('done');

        // Trigger browser download via presigned R2 URL
        window.location.href = data.url;

        // Clean up render job from R2 after a delay so download can begin first
        setTimeout(async () => {
            try { await apiCall(`/render/cleanup/${jobId}`, 'POST'); }
            catch (e) { console.error('Render cleanup failed:', e); }
        }, 4000);

    } catch (e) {
        showRenderError(e.message || 'Download failed');
    }
}

function showRenderError(msg) {
    showModalState('error');
    const el = document.getElementById('render-modal-error-text');
    if (el) el.textContent = msg;
}

// ==========================================
// Keyboard Shortcuts
// ==========================================
function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if focus is in an input field (like IN/OUT inputs)
        if (e.target.tagName.toLowerCase() === 'input') return;

        const video = document.getElementById('editor-video');
        if (!video || !videoDuration) return;

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            skipTime(-10);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            skipTime(10);
        } else if (e.key === ' ') {
            e.preventDefault();
            togglePlay();
        }
    });
}

// ==========================================
// Init
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    if (!checkAuth()) return;

    initVideoEvents();
    initTimeline();
    initTimeInputs();
    initKeyboardShortcuts();
    loadRecordingsList();
});
