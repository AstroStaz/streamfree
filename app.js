/* ============================================
   NOVATV — Full Application
   ============================================ */

// ─── CONFIG ──────────────────────────────────────────────
const API = window.location.origin;
const FLAG_BASE = 'https://purecatamphetamine.github.io/country-flag-icons/3x2';
const FAV_KEY = 'novatv_favorites';
const HISTORY_KEY = 'novatv_history';
const SETTINGS_KEY = 'novatv_settings';
const CHECK_CACHE = new Map();
const CHECK_TTL = 120000; // 2 minutes

let allChannels = [];
let filteredChannels = [];
let activeChannel = null;
let hls = null;
let displayLimit = 40;
let nextRefresh = null;
let showingFavorites = false;
let currentCategory = '';

// ─── DOM REFS ──────────────────────────────────────────
const $ = id => document.getElementById(id);
const searchInput = $('searchInput');
const countryFilter = $('countryFilter');
const mainContent = $('mainContent');
const heroThumb = $('heroThumb');
const heroTitle = $('heroTitle');
const heroMeta = $('heroMeta');
const heroLiveBadge = $('heroLiveBadge');
const heroSection = $('heroSection');
const categorySections = $('categorySections');
const refreshBtn = $('refreshBtn');
const countdownBadge = $('countdownBadge');
const countdownText = $('countdownText');
const favToggle = $('favToggle');
const toast = $('toast');
const settingsBtn = $('settingsBtn');
const settingsPanel = $('settingsPanel');
const closeSettings = $('closeSettings');
const channelCount = $('channelCount');

// Player refs
const overlay = $('playerOverlay');
const video = $('playerVideo');
const ctrlPlay = $('ctrlPlay');
const progressFill = $('progressFill');
const bufferedBar = $('bufferedBar');
const currentTime = $('currentTime');
const durationTime = $('durationTime');
const progressWrap = $('progressWrap');
const volSlider = $('volSlider');
const ctrlVol = $('ctrlVol');
const playerChannelLabel = $('playerChannelLabel');
const playerControls = $('playerControls');
const closePlayerBtn = $('closePlayerBtn');
const ctrlFullscreen = $('ctrlFullscreen');

let controlsTimer = null;
let isPlaying = false;
let isDragging = false;

// ─── HELPERS ────────────────────────────────────────────
function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
    return (s || '').replace(/"/g, '&quot;');
}

function getFlag(code) {
    if (!code || code.length !== 2) return null;
    return `${FLAG_BASE}/${code.toUpperCase()}.svg`;
}

function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._hide);
    toast._hide = setTimeout(() => toast.classList.remove('show'), 2200);
}

function debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ─── SETTINGS ──────────────────────────────────────────
function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettings() {
    const settings = loadSettings();
    // Theme
    const theme = settings.theme || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-opt').forEach(el => {
        el.classList.toggle('active', el.dataset.theme === theme);
    });
    // Accent
    const accent = settings.accent || '#3B82F6';
    document.documentElement.style.setProperty('--primary', accent);
    document.querySelectorAll('.accent-opt').forEach(el => {
        el.classList.toggle('active', el.dataset.accent === accent);
    });
    // Auto play
    const autoPlay = settings.autoPlay !== undefined ? settings.autoPlay : true;
    document.getElementById('autoPlayToggle').checked = autoPlay;
    // Remember volume
    const rememberVol = settings.rememberVolume !== undefined ? settings.rememberVolume : true;
    document.getElementById('rememberVolumeToggle').checked = rememberVol;
    if (rememberVol && settings.volume !== undefined) {
        video.volume = settings.volume;
        volSlider.value = settings.volume;
        updateVolIcon();
    }
}

// ─── FAVORITES ──────────────────────────────────────────
function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; }
}

function setFavorites(favs) { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); }

function isFavorite(id) { return getFavorites().includes(id); }

function toggleFavorite(id, e) {
    if (e) e.stopPropagation();
    const favs = getFavorites();
    const idx = favs.indexOf(id);
    if (idx > -1) favs.splice(idx, 1);
    else favs.push(id);
    setFavorites(favs);
    renderAllSections();
    showToast(idx > -1 ? 'Removed from favorites' : 'Added to favorites ⭐');
}

function toggleFavoritesFilter() {
    showingFavorites = !showingFavorites;
    favToggle.classList.toggle('active-fav', showingFavorites);
    favToggle.querySelector('.fav-icon').textContent = showingFavorites ? '⭐' : '☆';
    applyFilters();
}

// ─── HISTORY ────────────────────────────────────────────
function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function setHistory(history) { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }

function addToHistory(channel) {
    let history = getHistory();
    history = history.filter(h => h.id !== channel.id);
    history.unshift({ id: channel.id, name: channel.name, logo: channel.logo, group: channel.group, country: channel
            .country, url: channel.url });
    if (history.length > 20) history = history.slice(0, 20);
    setHistory(history);
}

function clearHistory() {
    setHistory([]);
    renderAllSections();
    showToast('History cleared');
}

// ─── STATUS CHECKS ──────────────────────────────────────
async function checkChannelStatuses(channels) {
    for (const ch of channels) {
        if (!ch.url) continue;
        const cached = CHECK_CACHE.get(ch.url);
        if (cached && Date.now() - cached.timestamp < CHECK_TTL) {
            ch._status = cached.status;
            continue;
        }
        try {
            const res = await fetch(`${API}/api/check?url=${encodeURIComponent(ch.url)}`);
            const data = await res.json();
            ch._status = data.alive ? 'live' : 'dead';
            CHECK_CACHE.set(ch.url, { status: ch._status, timestamp: Date.now() });
        } catch {
            ch._status = 'unknown';
        }
        // Update UI incrementally
        renderAllSections();
        updateHero();
    }
}

function getStatusDot(status) {
    if (status === 'live') return 'live';
    if (status === 'dead') return 'dead';
    return 'unknown';
}

// ─── LOAD CHANNELS ──────────────────────────────────────
async function loadChannels(force = false) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳';
    showLoadingState();

    try {
        const res = await fetch(`${API}/api/channels${force ? '?refresh=true' : ''}`);
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        allChannels = data.channels.map((ch, i) => ({ ...ch, id: `ch-${i}` }));
        // Update count
        if (channelCount) channelCount.textContent = `${allChannels.length.toLocaleString()} channels`;

        nextRefresh = Date.now() + 30 * 60 * 1000;
        countdownBadge.style.display = 'flex';
        startCountdown();

        populateFilters();
        applyFilters();

        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻';

        // Set featured
        if (allChannels.length) setFeatured(allChannels[0]);
        // Pre-check first 30
        checkChannelStatuses(allChannels.slice(0, 30));

    } catch (e) {
        console.error(e);
        showErrorState(e.message);
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻';
    }
}

function showLoadingState() {
    categorySections.innerHTML = '';
    // Render skeleton sections
    const sections = ['Trending', 'Sports', 'News', 'Entertainment'];
    categorySections.innerHTML = sections.map(s => `
            <div class="category-section">
                <div class="section-header"><h2>${s}</h2></div>
                <div class="category-scroll">
                    ${Array(6).fill(0).map(() => `
                        <div class="skeleton-card">
                            <div class="s-thumb"></div>
                            <div class="s-line"></div>
                            <div class="s-line short"></div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    heroTitle.textContent = 'Loading channels...';
    heroMeta.innerHTML = '<span class="tag">Fetching playlist...</span>';
    heroThumb.textContent = '📡';
    heroLiveBadge.style.display = 'none';
    if (channelCount) channelCount.textContent = 'Loading...';
}

function showErrorState(msg) {
    categorySections.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <span class="icon">⚠️</span>
                <div class="title">Connection Error</div>
                <div class="sub">${escHtml(msg)}<br><br>
                    <button onclick="loadChannels()" style="background:var(--primary);border:none;border-radius:40px;color:#fff;padding:8px 28px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-top:8px;">Try Again</button>
                </div>
            </div>
        `;
}

// ─── POPULATE FILTERS ──────────────────────────────────
function populateFilters() {
    const countries = Array.from(new Set(allChannels.map(c => c.country).filter(Boolean))).sort();
    countryFilter.innerHTML = `<option value="">All Countries</option>` +
        countries.map(c => `<option value="${escAttr(c)}">${escHtml(c)}</option>`).join('');
}

// ─── APPLY FILTERS ──────────────────────────────────────
function applyFilters() {
    const q = searchInput.value.toLowerCase().trim();
    const country = countryFilter.value;
    const favs = getFavorites();

    filteredChannels = allChannels.filter(ch => {
        if (country && ch.country !== country) return false;
        if (showingFavorites && !favs.includes(ch.id)) return false;
        if (q && !ch.name.toLowerCase().includes(q) &&
            !(ch.group || '').toLowerCase().includes(q) &&
            !(ch.country || '').toLowerCase().includes(q)) return false;
        return true;
    });

    displayLimit = 40;
    renderAllSections();
    updateHero();
}

// ─── RENDER ALL SECTIONS ──────────────────────────────
function renderAllSections() {
    const favs = getFavorites();
    const history = getHistory();

    // Build category sections dynamically
    const categoryMap = {};
    allChannels.forEach(ch => {
        const group = ch.group || 'General';
        if (!categoryMap[group]) categoryMap[group] = [];
        categoryMap[group].push(ch);
    });

    // Define order of sections
    const order = ['Trending', 'Sports', 'News', 'Entertainment', 'Music', 'Kids', 'Documentary', 'International',
        'General'
    ];
    const sortedKeys = Object.keys(categoryMap).sort((a, b) => {
        const idxA = order.indexOf(a);
        const idxB = order.indexOf(b);
        if (idxA === -1 && idxB === -1) return a.localeCompare(b);
        if (idxA === -1) return 1;
        if (idxB === -1) return -1;
        return idxA - idxB;
    });

    // History section
    let html = '';
    if (history.length > 0) {
        html += renderSection('Continue Watching', history.slice(0, 10), true);
    }

    // Favorites section
    const favChannels = allChannels.filter(ch => favs.includes(ch.id));
    if (favChannels.length > 0) {
        html += renderSection('⭐ Favorites', favChannels.slice(0, 10), true);
    }

    // Dynamic categories (only show if they have channels after filtering)
    sortedKeys.forEach(key => {
        const channels = filteredChannels.filter(ch => (ch.group || 'General') === key);
        if (channels.length > 0) {
            html += renderSection(key, channels.slice(0, 20), false);
        }
    });

    // If no channels at all, show empty
    if (!html) {
        html = `
                <div class="empty-state">
                    <span class="icon">🔍</span>
                    <div class="title">No channels found</div>
                    <div class="sub">Try adjusting your search or filters</div>
                </div>
            `;
    }

    categorySections.innerHTML = html;
}

function renderSection(title, channels, isSpecial) {
    if (!channels.length) return '';
    const favs = getFavorites();
    return `
            <div class="category-section">
                <div class="section-header">
                    <h2>${escHtml(title)}</h2>
                    <span class="see-all" onclick="showAllFromSection('${escAttr(title)}')">See all →</span>
                </div>
                <div class="category-scroll">
                    ${channels.map(ch => channelCardHTML(ch, favs)).join('')}
                </div>
            </div>
        `;
}

function channelCardHTML(ch, favs) {
    const flag = ch.country && ch.country.length === 2 ?
        `<img src="${FLAG_BASE}/${ch.country.toUpperCase()}.svg" class="flag" onerror="this.style.display='none'" />` :
        '';
    const logo = ch.logo ?
        `<img src="${escAttr(ch.logo)}" onerror="this.style.display='none'" />` :
        '📺';
    const isFav = favs.includes(ch.id);
    const dot = getStatusDot(ch._status);
    return `
            <div class="channel-card" onclick="playChannel('${ch.id}')" data-id="${ch.id}">
                <div class="status-dot ${dot}"></div>
                <div class="thumb">${logo}</div>
                <div class="name">${escHtml(ch.name)}</div>
                <div class="meta">
                    ${flag}
                    <span class="group">${escHtml(ch.group || 'General')}</span>
                </div>
                <button class="fav-star${isFav ? ' active' : ''}" onclick="toggleFavorite('${ch.id}', event)" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '⭐' : '☆'}</button>
            </div>
        `;
}

// ─── SHOW ALL FROM SECTION ─────────────────────────────
function showAllFromSection(category) {
    // For simplicity, set the search to the category name
    searchInput.value = category;
    applyFilters();
    // Scroll to top
    mainContent.scrollTop = 0;
}

// ─── HERO ──────────────────────────────────────────────
function setFeatured(ch) {
    if (!ch) return;
    heroSection.dataset.channelId = ch.id;
    const logo = ch.logo ?
        `<img src="${escAttr(ch.logo)}" onerror="this.style.display='none'" style="width:100%;height:100%;object-fit:contain" />` :
        '📺';
    heroThumb.innerHTML = logo;
    heroTitle.textContent = ch.name;
    const flag = ch.country && ch.country.length === 2 ?
        `<img src="${FLAG_BASE}/${ch.country.toUpperCase()}.svg" class="flag" style="width:16px;height:11px;border-radius:2px;vertical-align:middle;margin-right:4px;" onerror="this.style.display='none'" />` :
        '';
    heroMeta.innerHTML = `
            <span class="tag">${flag} ${escHtml(ch.group || 'General')}</span>
            <span class="tag">${ch.language || ''}</span>
            <span class="tag" style="color:${ch._status === 'live' ? 'var(--accent)' : ch._status === 'dead' ? 'var(--danger)' : 'var(--text-muted)'};">● ${ch._status === 'live' ? 'Live' : ch._status === 'dead' ? 'Offline' : 'Checking...'}</span>
        `;
    heroLiveBadge.style.display = ch._status === 'live' ? 'block' : 'none';
}

function updateHero() {
    const id = heroSection.dataset.channelId;
    if (!id) return;
    const ch = allChannels.find(c => c.id === id);
    if (ch) setFeatured(ch);
}

function playFeatured() {
    const id = heroSection.dataset.channelId;
    if (id) playChannel(id);
}

// ─── PLAY CHANNEL ──────────────────────────────────────
function playChannel(id) {
    const ch = allChannels.find(c => c.id === id);
    if (!ch) return;
    activeChannel = ch;
    setFeatured(ch);
    addToHistory(ch);
    openPlayer(ch);
    renderAllSections();
}

// ─── PLAYER ────────────────────────────────────────────
function openPlayer(ch) {
    overlay.classList.add('open');
    playerChannelLabel.textContent = ch.name;
    if (hls) { hls.destroy();
        hls = null; }

    const src = ch.url;
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        hls = new Hls({ enableWorker: false, maxBufferLength: 30 });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const autoPlay = loadSettings().autoPlay !== undefined ? loadSettings().autoPlay : true;
            if (autoPlay) video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
                console.warn('HLS fatal, fallback to native');
                hls.destroy();
                hls = null;
                video.src = src;
                const autoPlay = loadSettings().autoPlay !== undefined ? loadSettings().autoPlay : true;
                if (autoPlay) video.play().catch(() => {});
            }
        });
    } else {
        video.src = src;
        const autoPlay = loadSettings().autoPlay !== undefined ? loadSettings().autoPlay : true;
        if (autoPlay) video.play().catch(() => {});
    }

    video.addEventListener('play', () => { isPlaying = true;
        updatePlayBtn(); });
    video.addEventListener('pause', () => { isPlaying = false;
        updatePlayBtn(); });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', updateDuration);
    video.addEventListener('waiting', () => {});
    video.addEventListener('canplay', () => {});

    // Controls visibility
    playerControls.classList.add('visible');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
        if (isPlaying) playerControls.classList.remove('visible');
    }, 3000);

    // Click video to toggle controls
    video.onclick = () => {
        if (playerControls.classList.contains('visible')) {
            playerControls.classList.remove('visible');
            clearTimeout(controlsTimer);
        } else {
            playerControls.classList.add('visible');
            clearTimeout(controlsTimer);
            controlsTimer = setTimeout(() => {
                if (isPlaying) playerControls.classList.remove('visible');
            }, 3000);
        }
    };

    // Mouse move shows controls
    overlay.querySelector('.player-wrap').addEventListener('mousemove', () => {
        playerControls.classList.add('visible');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            if (isPlaying) playerControls.classList.remove('visible');
        }, 3000);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', playerKeyHandler);

    // Volume
    volSlider.value = video.volume;
    volSlider.oninput = () => {
        video.volume = parseFloat(volSlider.value);
        video.muted = false;
        updateVolIcon();
        if (loadSettings().rememberVolume) {
            const settings = loadSettings();
            settings.volume = video.volume;
            saveSettings(settings);
        }
    };

     // Progress bar click
    progressWrap.onclick = (e) => {
        const rect = progressWrap.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        video.currentTime = pct * (video.duration || 0);
    };

    // Init
    updatePlayBtn();
    updateVolIcon();
}

function closePlayer() {
    overlay.classList.remove('open');
    if (hls) { hls.destroy();
        hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    document.removeEventListener('keydown', playerKeyHandler);
    // Save volume if remembered
    if (loadSettings().rememberVolume) {
        const settings = loadSettings();
        settings.volume = video.volume;
        saveSettings(settings);
    }
}

function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
}

function updatePlayBtn() {
    ctrlPlay.textContent = isPlaying ? '⏸' : '▶';
}

function skip(seconds) {
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + seconds));
}

function toggleMute() {
    video.muted = !video.muted;
    updateVolIcon();
}

function updateVolIcon() {
    if (video.muted || video.volume === 0) ctrlVol.textContent = '🔇';
    else if (video.volume < 0.5) ctrlVol.textContent = '🔉';
    else ctrlVol.textContent = '🔊';
    if (video.muted) volSlider.value = 0;
    else volSlider.value = video.volume;
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        overlay.requestFullscreen?.().catch(() => {});
    } else {
        document.exitFullscreen?.();
    }
}

function updateProgress() {
    if (isDragging) return;
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    progressFill.style.width = pct + '%';
    currentTime.textContent = formatTime(video.currentTime);
    if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        const bpct = video.duration ? (end / video.duration) * 100 : 0;
        bufferedBar.style.width = bpct + '%';
    }
}

function updateDuration() {
    durationTime.textContent = formatTime(video.duration || 0);
}

let playerKeyHandler = (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
        case ' ':
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            skip(-10);
            break;
        case 'ArrowRight':
            e.preventDefault();
            skip(10);
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            break;
        case 'Escape':
            if (document.fullscreenElement) document.exitFullscreen?.();
            else closePlayer();
            break;
        case 'm':
        case 'M':
            toggleMute();
            break;
    }
};

// ─── COUNTDOWN ──────────────────────────────────────────
function startCountdown() {
    clearInterval(window._cd);
    window._cd = setInterval(() => {
        if (!nextRefresh) return;
        const diff = nextRefresh - Date.now();
        if (diff <= 0) {
            countdownText.textContent = '0s';
            loadChannels();
            return;
        }
        const s = Math.floor(diff / 1000);
        countdownText.textContent = `${s}s`;
    }, 1000);
}

// ─── SETTINGS UI ──────────────────────────────────────
function openSettings() {
    settingsPanel.classList.add('open');
}

function closeSettingsPanel() {
    settingsPanel.classList.remove('open');
}

settingsBtn.addEventListener('click', openSettings);
closeSettings.addEventListener('click', closeSettingsPanel);

// Theme options
document.querySelectorAll('.theme-opt').forEach(el => {
    el.addEventListener('click', () => {
        const theme = el.dataset.theme;
        const settings = loadSettings();
        settings.theme = theme;
        saveSettings(settings);
        applySettings();
    });
});

// Accent options
document.querySelectorAll('.accent-opt').forEach(el => {
    el.addEventListener('click', () => {
        const accent = el.dataset.accent;
        const settings = loadSettings();
        settings.accent = accent;
        saveSettings(settings);
        applySettings();
    });
});

// Auto play
document.getElementById('autoPlayToggle').addEventListener('change', (e) => {
    const settings = loadSettings();
    settings.autoPlay = e.target.checked;
    saveSettings(settings);
});

// Remember volume
document.getElementById('rememberVolumeToggle').addEventListener('change', (e) => {
    const settings = loadSettings();
    settings.rememberVolume = e.target.checked;
    if (!e.target.checked) {
        delete settings.volume;
    }
    saveSettings(settings);
});

// Clear history
document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

// ─── SEARCH & FILTER EVENTS ────────────────────────────
searchInput.addEventListener('input', debounce(applyFilters, 300));
countryFilter.addEventListener('change', applyFilters);
favToggle.addEventListener('click', toggleFavoritesFilter);

// ─── CLOSE PLAYER BUTTON ──────────────────────────────
closePlayerBtn.addEventListener('click', closePlayer);

// ─── FULLSCREEN BUTTON ────────────────────────────────
ctrlFullscreen.addEventListener('click', toggleFullscreen);

// ─── VOLUME CONTROLS ───────────────────────────────────
ctrlVol.addEventListener('click', toggleMute);

// ─── PLAY BUTTON ───────────────────────────────────────
ctrlPlay.addEventListener('click', togglePlay);

// ─── SKIP BUTTONS ──────────────────────────────────────
document.getElementById('ctrlSkipBack').addEventListener('click', () => skip(-10));
document.getElementById('ctrlSkipForward').addEventListener('click', () => skip(10));

// ─── KEYBOARD SHORTCUTS (global) ──────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
        if (!document.fullscreenElement) closePlayer();
    }
    if (e.key === 'f' && overlay.classList.contains('open')) {
        e.preventDefault();
        toggleFullscreen();
    }
});

// ─── FULLSCREEN CHANGE ──────────────────────────────────
document.addEventListener('fullscreenchange', () => {
    ctrlFullscreen.textContent = document.fullscreenElement ? '⛶' : '⛶';
});

// ─── INIT ──────────────────────────────────────────────
applySettings();
loadChannels();

console.log('🚀 NovaTV loaded');
console.log('📺 Ready to stream');