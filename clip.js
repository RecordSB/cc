const WORKER_URL = "https://church-recorder-worker.tarstco.workers.dev";
let currentPassword = null;

document.addEventListener("DOMContentLoaded", async () => {
    const savedPassword = sessionStorage.getItem('recordsb_password');
    if (savedPassword) {
        currentPassword = savedPassword;
        document.getElementById('login-screen-clip').classList.add('hidden');
        document.getElementById('clip-app-wrapper').classList.remove('hidden');
        await loadClipByHash();
    } else {
        document.getElementById('clip-app-wrapper').classList.add('hidden');
        document.getElementById('login-screen-clip').classList.remove('hidden');
    }

    const loginForm = document.getElementById("login-form-clip");
    if (loginForm) loginForm.addEventListener("submit", handleLogin);

    window.addEventListener('hashchange', async () => {
        if (currentPassword) {
            await loadClipByHash();
        }
    });
});

async function apiCall(endpoint, method = "GET", body = null) {
    const headers = { "Content-Type": "application/json" };
    if (currentPassword) headers["X-Password"] = currentPassword;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${WORKER_URL}${endpoint}`, options);
    return response;
}

async function handleLogin(e) {
    e.preventDefault();
    const pwdInput = document.getElementById("password-clip").value;
    const errorEl = document.getElementById("login-error-clip");
    const submitBtn = document.getElementById("login-submit-clip");

    if (errorEl) errorEl.classList.add("hidden");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Logging in...";
    }

    try {
        currentPassword = pwdInput;
        const recRes = await apiCall("/recordings");
        if (recRes.status === 401) {
            currentPassword = null;
            if (errorEl) {
                errorEl.textContent = "Incorrect password. Please try again.";
                errorEl.classList.remove('hidden');
            }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Log In"; }
            return;
        }
        if (!recRes.ok) throw new Error("Failed to authenticate.");

        sessionStorage.setItem('recordsb_password', pwdInput);
        document.getElementById('login-screen-clip').classList.add('hidden');
        document.getElementById('clip-app-wrapper').classList.remove('hidden');
        await loadClipByHash();

    } catch (error) {
        currentPassword = null;
        if (errorEl) {
            errorEl.textContent = error.message || String(error);
            errorEl.classList.remove("hidden");
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Log In";
        }
    }
}

async function loadClipByHash() {
    const hash = window.location.hash ? window.location.hash.substring(1) : '';
    const decodedHash = decodeURIComponent(hash).trim();

    const loadingEl = document.getElementById('clip-loading');
    const errorCard = document.getElementById('clip-error-card');
    const contentEl = document.getElementById('clip-content');
    const errorTitle = document.getElementById('clip-error-title');
    const errorDesc = document.getElementById('clip-error-desc');

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (errorCard) errorCard.classList.add('hidden');
    if (contentEl) contentEl.classList.add('hidden');

    if (!decodedHash) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errorCard) errorCard.classList.remove('hidden');
        if (errorTitle) errorTitle.textContent = "No Recording Specified";
        if (errorDesc) errorDesc.textContent = "Please provide a recording name in the URL hash (e.g. clip.html/#10AM_9%2F13).";
        return;
    }

    try {
        const res = await apiCall("/recordings");
        if (res.status === 401) {
            currentPassword = null;
            sessionStorage.removeItem('recordsb_password');
            if (loadingEl) loadingEl.classList.add('hidden');
            document.getElementById('clip-app-wrapper').classList.add('hidden');
            document.getElementById('login-screen-clip').classList.remove('hidden');
            return;
        }
        if (!res.ok) throw new Error("Failed to fetch recordings");
        const recordings = await res.json();

        const matched = recordings.find(r => {
            const name = (r.recording_name || r.recordingName || '').trim();
            return name.toLowerCase() === decodedHash.toLowerCase();
        });

        if (loadingEl) loadingEl.classList.add('hidden');

        if (!matched) {
            if (errorCard) errorCard.classList.remove('hidden');
            if (errorTitle) errorTitle.textContent = "Clip Does Not Exist";
            if (errorDesc) errorDesc.textContent = `No recording named "${decodedHash}" was found in the system.`;
            return;
        }

        const status = (matched.status || '').toString().toLowerCase();
        const isDeleted = ['deleted', 'removed', 'canceled', 'cancelled'].includes(status) || matched.deleted === true || matched.isDeleted === true;

        if (isDeleted) {
            if (errorCard) errorCard.classList.remove('hidden');
            if (errorTitle) errorTitle.textContent = "Recording Was Deleted";
            if (errorDesc) errorDesc.textContent = `The recording "${decodedHash}" existed previously but has been deleted from storage.`;
            return;
        }

        renderClipDetails(matched);

    } catch (e) {
        console.error("Error loading clip:", e);
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errorCard) errorCard.classList.remove('hidden');
        if (errorTitle) errorTitle.textContent = "Error Loading Clip";
        if (errorDesc) errorDesc.textContent = e.message || "An unexpected error occurred while loading clip details.";
    }
}

function renderClipDetails(rec) {
    const contentEl = document.getElementById('clip-content');
    if (contentEl) contentEl.classList.remove('hidden');

    const id = rec.id || rec.jobId;
    const recName = rec.recording_name || rec.recordingName || 'Untitled Recording';
    const createdAt = rec.created_at || rec.startTime || rec.start_time;
    const durationMins = rec.duration_minutes || rec.durationMinutes || '-';
    const downloads = rec.download_count || rec.downloadCount || 0;
    const status = (rec.status || 'done').toLowerCase();

    const headerName = document.getElementById('clip-header-name');
    if (headerName) {
        headerName.textContent = recName;
        headerName.classList.remove('hidden');
    }

    const titleEl = document.getElementById('clip-title');
    if (titleEl) titleEl.textContent = recName;

    const dateEl = document.getElementById('clip-date');
    if (dateEl) {
        dateEl.textContent = createdAt ? new Date(createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-';
    }

    const durationEl = document.getElementById('clip-duration');
    if (durationEl) durationEl.textContent = `${durationMins} mins`;

    const badgeEl = document.getElementById('clip-status-badge');
    if (badgeEl) {
        badgeEl.textContent = status;
        badgeEl.className = `badge badge-${status}`;
    }

    const autodeleteEl = document.getElementById('clip-autodelete');
    if (createdAt && autodeleteEl) {
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
                const days = Math.floor(remaining / dayMs);
                autodeleteText = `${days}d`;
            } else if (remaining >= hourMs) {
                const hours = Math.floor(remaining / hourMs);
                autodeleteText = `${hours}h`;
            } else {
                autodeleteText = '<1hr';
            }
        }
        autodeleteEl.innerHTML = `<span>&bull;</span> <span class="text-xs text-gray-500">deletes in ${autodeleteText}</span>`;
        autodeleteEl.classList.remove('hidden');
    }

    const downloadsEl = document.getElementById('clip-downloads');
    if (downloadsEl) downloadsEl.textContent = downloads;

    const typeEl = document.getElementById('clip-type');
    if (typeEl) typeEl.textContent = rec.job_type === 'clip' ? 'Buffer Clip' : 'Livestream Recording';

    const idEl = document.getElementById('clip-id');
    if (idEl) idEl.textContent = id;

    const deletionStatusEl = document.getElementById('clip-deletion-status');
    if (deletionStatusEl) deletionStatusEl.textContent = 'Active (Stored)';

    const actionButtonsContainer = document.getElementById('clip-action-buttons');
    const headerActionsContainer = document.getElementById('header-actions');

    const buttonsHtml = `
        <button onclick="copyShareLink(this, '${encodeURIComponent(recName)}')" class="inline-flex items-center px-3 py-2 border border-gray-300 text-xs font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none">
            <svg class="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 18.5088C1 13.1679 4.90169 8.77098 9.99995 7.84598V5.51119C9.99995 3.63887 12.1534 2.58563 13.6313 3.73514L21.9742 10.224C23.1323 11.1248 23.1324 12.8752 21.9742 13.7761L13.6314 20.2649C12.1534 21.4144 10 20.3612 10 18.4888V16.5189C7.74106 16.9525 5.9625 18.1157 4.92778 19.6838C4.33222 20.5863 3.30568 20.7735 2.55965 20.5635C1.80473 20.3511 1.00011 19.6306 1 18.5088ZM12.4034 5.31385C12.2392 5.18613 11.9999 5.30315 11.9999 5.51119V9.41672C11.9999 9.55479 11.8873 9.66637 11.7493 9.67008C8.09094 9.76836 4.97774 12.0115 3.66558 15.1656C3.46812 15.6402 3.31145 16.1354 3.19984 16.6471C3.07554 17.217 3.00713 17.8072 3.00053 18.412C3.00018 18.4442 3 18.4765 3 18.5088C3.00001 18.6437 3.18418 18.6948 3.25846 18.5822C3.27467 18.5577 3.29101 18.5332 3.30747 18.5088C3.30748 18.5088 3.30746 18.5088 3.30747 18.5088C3.63446 18.0244 4.01059 17.5765 4.42994 17.168C4.71487 16.8905 5.01975 16.6313 5.34276 16.3912C7.05882 15.1158 9.28642 14.3823 11.7496 14.3357C11.8877 14.3331 12 14.4453 12 14.5834V18.4888C12 18.6969 12.2393 18.8139 12.4035 18.6862L20.7463 12.1973C20.875 12.0973 20.875 11.9028 20.7463 11.8027L12.4034 5.31385Z" fill="currentColor"/></svg>
            Share
        </button>
        <button onclick="downloadRecording(this, '${id}', '${escapeHtml(recName)}')" class="inline-flex items-center px-4 py-2 border border-transparent text-xs font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
            Download
        </button>
    `;

    if (actionButtonsContainer) actionButtonsContainer.innerHTML = buttonsHtml;
    if (headerActionsContainer) headerActionsContainer.innerHTML = buttonsHtml;

    loadVideoPreview(id);
}

async function loadVideoPreview(id) {
    const loadingEl = document.getElementById('preview-loading');
    const videoEl = document.getElementById('clip-video-player');
    if (!loadingEl || !videoEl) return;

    loadingEl.classList.remove('hidden');

    try {
        const res = await apiCall(`/watch/${id}`);
        if (!res.ok) throw new Error("Failed to get watch URL");
        const data = await res.json();
        if (!data.url) throw new Error("No watch URL returned");

        videoEl.src = data.url;
        videoEl.onloadeddata = () => {
            loadingEl.classList.add('hidden');
        };
        videoEl.onerror = () => {
            loadingEl.classList.add('hidden');
        };
    } catch (e) {
        console.error("Preview load error:", e);
        loadingEl.classList.add('hidden');
    }
}

window.downloadRecording = async function(btnEl, id, suggestedName) {
    if (!id) return showTooltip(btnEl, 'Missing recording id');
    
    try {
        const res = await apiCall(`/download/${id}`);
        if (!res.ok) {
            let msg = 'Download failed';
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch(e) {}
            showTooltip(btnEl, 'Download failed: ' + msg);
            return;
        }
        const data = await res.json();
        if (!data.url) { 
            showTooltip(btnEl, 'Failed to get download URL'); 
            return; 
        }
        window.location.href = data.url;
    } catch (e) {
        console.error('Download error', e);
        showTooltip(btnEl, 'Download failed: ' + (e.message || e));
    }
};

window.copyShareLink = function(el, name) {
    const url = `https://recordsb.github.io/cc/clip.html/#${name}`;
    navigator.clipboard.writeText(url).then(() => {
        showTooltip(el, 'Share Link Copied!');
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
};

function showTooltip(el, message) {
    // NOTE: this element is styled entirely with inline styles, never
    // Tailwind utility classes. Tailwind's CDN/JIT compiler only generates
    // CSS for classes it can find while scanning the page's HTML/DOM - it
    // does not reliably pick up class names that only ever appear as
    // strings inside an external .js file. That's why this used to be
    // unstyled on first use (CSS not generated in time) and only looked
    // right from the second click onward (by then the CDN had caught up).
    // Inline styles apply synchronously and never depend on that scan.
    let tooltip = document.getElementById('recordsb-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'recordsb-tooltip';
        document.body.appendChild(tooltip);
    }

    tooltip.style.cssText = `
        position: fixed;
        top: -9999px;
        left: -9999px;
        z-index: 9999;
        box-sizing: border-box;
        display: block;
        width: max-content;
        max-width: 260px;
        margin: 0;
        padding: 6px 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.3;
        color: #374151;
        background-color: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        white-space: normal;
        text-align: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity 150ms ease;
    `;

    tooltip.textContent = message;

    // `position: fixed` anchors to the viewport, not to the button, so a
    // one-time position calculation goes stale the instant the page
    // scrolls - the button moves with the content, the tooltip doesn't.
    // Recomputing on every scroll/resize keeps it glued to the button.
    function positionTooltip() {
        const btnRect = el.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();

        let left = btnRect.left + (btnRect.width / 2) - (tipRect.width / 2);
        left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

        let top = btnRect.bottom + 8;
        // Flip above the button if there's no room below it.
        if (top + tipRect.height > window.innerHeight - 8) {
            top = btnRect.top - tipRect.height - 8;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    // Wait a frame so the browser has actually laid the element out with
    // its new text/width before we measure and position it - this is what
    // guarantees correct centering on the very first click, not just the
    // second one.
    requestAnimationFrame(() => {
        positionTooltip();
        tooltip.style.opacity = '1';
    });

    // Throttle scroll/resize repositioning to one update per frame.
    // `capture: true` on window catches scroll events fired on any
    // scrollable container on the page, not just the window itself
    // (scroll events don't bubble, but the capture phase still reaches
    // window on the way down).
    let repositionQueued = false;
    function onViewportChange() {
        if (repositionQueued) return;
        repositionQueued = true;
        requestAnimationFrame(() => {
            positionTooltip();
            repositionQueued = false;
        });
    }

    if (tooltip._cleanupListeners) tooltip._cleanupListeners();
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    tooltip._cleanupListeners = () => {
        window.removeEventListener('scroll', onViewportChange, { capture: true });
        window.removeEventListener('resize', onViewportChange);
    };

    // Clear existing timeout to handle rapid button clicks correctly
    if (tooltip._hideTimeout) clearTimeout(tooltip._hideTimeout);
    tooltip._hideTimeout = setTimeout(() => {
        tooltip.style.opacity = '0';
        if (tooltip._cleanupListeners) {
            tooltip._cleanupListeners();
            tooltip._cleanupListeners = null;
        }
    }, 2000);
}

function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return unsafe.toString().replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#039;');
}