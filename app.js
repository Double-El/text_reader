// Application State Variables
// If opened via file:// or deployed on GitHub Pages (not localhost), point to localhost:8000
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '8000') 
    ? '' 
    : 'http://localhost:8000';
let audioUrl = ""; // Combined MP3 URL for download
let chunks = [];   // Array of chunks {text, audioUrl}
let currentChunkIndex = -1;
let activeAudio = null;
let isPlaying = false;
let isPaused = false;

// Web Speech API fallback state
let synth = window.speechSynthesis;
let currentUtterance = null;
let isBackendAvailable = false;

// Function to check if local server is online
async function checkBackendStatus() {
    try {
        // Use translate API to ping backend
        const res = await fetch(`${API_BASE}/api/translate?q=ping`, { 
            method: 'GET'
        });
        if (res.ok) {
            isBackendAvailable = true;
            console.log("Backend server detected. Running in standard mode.");
        } else {
            isBackendAvailable = false;
            console.warn("Backend server is offline or returned error. Falling back to Web Speech API.");
        }
    } catch (e) {
        isBackendAvailable = false;
        console.warn("Backend server is offline. Falling back to Web Speech API.", e);
    }
}

// Background TTS Generation State
let ttsGenerationPromise = null;
let debounceTimer = null;

// DOM Elements
const textInput = document.getElementById('textInput');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const dropZone = document.getElementById('dropZone');
const dragOverlay = document.getElementById('dragOverlay');
const fileUpload = document.getElementById('fileUpload');

const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');

const liveSubtitle = document.getElementById('liveSubtitle');
const readingStatusText = document.getElementById('readingStatusText');
const visualizer = document.getElementById('visualizer');
const progressBarFill = document.getElementById('progressBarFill');
const progressPercent = document.getElementById('progressPercent');
const progressRatio = document.getElementById('progressRatio');

const filterSpecialCheck = document.getElementById('filterSpecialChars');
const rateRange = document.getElementById('rateRange');
const rateValue = document.getElementById('rateValue');
const volumeRange = document.getElementById('volumeRange');
const volumeValue = document.getElementById('volumeValue');
const themeToggle = document.getElementById('themeToggle');

const statOriginalChar = document.getElementById('statOriginalChar');
const statFilteredChar = document.getElementById('statFilteredChar');
const statWords = document.getElementById('statWords');
const statDuration = document.getElementById('statDuration');

// Loader Overlay Elements
const loaderOverlay = document.getElementById('loaderOverlay');
const loaderTitle = document.getElementById('loaderTitle');
const loaderDesc = document.getElementById('loaderDesc');

// Theme Management (Default Dark Mode)
let currentTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);
updateThemeToggleIcon();

themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('theme', currentTheme);
    updateThemeToggleIcon();
});

function updateThemeToggleIcon() {
    const sunIcon = themeToggle.querySelector('.sun-icon');
    const moonIcon = themeToggle.querySelector('.moon-icon');
    if (currentTheme === 'dark') {
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';
    } else {
        sunIcon.style.display = 'none';
        moonIcon.style.display = 'block';
    }
}

// Text Processing & Filtering (client-side preview)
function filterText(text, excludeSpecial = true) {
    if (!text) return '';
    if (!excludeSpecial) return text;
    
    // Keep Korean, English, numbers, spaces, and basic punctuation marks
    const regex = /[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s.,!?]/g;
    let cleaned = text.replace(regex, '');
    
    // Clean multiple spaces into a single space
    cleaned = cleaned.replace(/ +/g, ' ');
    
    return cleaned;
}

// JavaScript-based sentence splitter for instant playback
function splitTextIntoSentences(text) {
    const isFilter = filterSpecialCheck.checked;
    const cleanText = filterText(text, isFilter);
    if (!cleanText) return [];
    
    // Split by sentence endings (.!? or newlines)
    const rawSentences = cleanText.split(/([.\n!?]+)/g);
    const sentences = [];
    let currentChunk = "";
    
    for (let i = 0; i < rawSentences.length; i++) {
        const part = rawSentences[i];
        if (!part) continue;
        
        if (/[.!?\n]+/.test(part)) {
            currentChunk += part;
            if (currentChunk.trim()) {
                sentences.push(currentChunk.trim());
            }
            currentChunk = "";
        } else {
            if (currentChunk.length + part.length > 100) {
                if (currentChunk.trim()) {
                    sentences.push(currentChunk.trim());
                }
                
                // If the sentence itself is too long, split it by words
                const words = part.split(' ');
                let temp = "";
                for (const word of words) {
                    if (temp.length + word.length + 1 > 100) {
                        if (temp.trim()) {
                            sentences.push(temp.trim());
                        }
                        temp = word + " ";
                    } else {
                        temp += word + " ";
                    }
                }
                currentChunk = temp;
            } else {
                currentChunk += part;
            }
        }
    }
    
    if (currentChunk.trim()) {
        sentences.push(currentChunk.trim());
    }
    
    return sentences.filter(s => s.length > 0);
}

// Calculate and Update Real-time Statistics
function updateStats() {
    const text = textInput.value;
    const isFilter = filterSpecialCheck.checked;
    
    const originalLen = text.length;
    const cleanVal = filterText(text, isFilter);
    const filteredLen = cleanVal.length;
    
    const words = cleanVal.trim() ? cleanVal.trim().split(/\s+/).length : 0;
    
    const rate = parseFloat(rateRange.value);
    const charPerMin = 320 * rate;
    const estimatedMinutes = charPerMin > 0 ? (filteredLen / charPerMin) : 0;
    
    statOriginalChar.textContent = originalLen.toLocaleString();
    statFilteredChar.textContent = filteredLen.toLocaleString();
    statWords.textContent = words.toLocaleString();
    
    if (estimatedMinutes < 1) {
        const sec = Math.ceil(estimatedMinutes * 60);
        statDuration.textContent = `~${sec}초`;
    } else {
        const min = Math.floor(estimatedMinutes);
        const sec = Math.round((estimatedMinutes - min) * 60);
        statDuration.textContent = `~${min}분 ${sec}초`;
    }
}

// Update playback progress bar
function updateProgress() {
    if (chunks.length === 0 || currentChunkIndex < 0) return;
    
    const percentage = Math.round(((currentChunkIndex + 1) / chunks.length) * 100);
    progressBarFill.style.width = `${percentage}%`;
    progressPercent.textContent = `${percentage}%`;
    
    let totalChars = chunks.reduce((acc, curr) => acc + curr.text.length, 0);
    let readChars = chunks.slice(0, currentChunkIndex + 1).reduce((acc, curr) => acc + curr.text.length, 0);
    progressRatio.textContent = `${readChars.toLocaleString()} / ${totalChars.toLocaleString()} 자`;
}

// Adjust UI elements according to current state
function playbackStateUI(state) {
    if (state === 'playing') {
        playBtn.disabled = true;
        pauseBtn.disabled = false;
        stopBtn.disabled = false;
        
        visualizer.classList.add('playing');
        document.querySelector('.subtitle-card').classList.add('speaking');
    } 
    else if (state === 'paused') {
        playBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = false;
        
        visualizer.classList.remove('playing');
        readingStatusText.textContent = '일시 정지됨';
    } 
    else if (state === 'stopped') {
        playBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        
        visualizer.classList.remove('playing');
        document.querySelector('.subtitle-card').classList.remove('speaking');
        readingStatusText.textContent = '정지됨';
        liveSubtitle.textContent = '낭독을 시작하면 여기에 실시간으로 읽고 있는 문장이 하이라이트 표시됩니다.';
        
        progressBarFill.style.width = '0%';
        progressPercent.textContent = '0%';
        progressRatio.textContent = '0 / 0 자';
    }
}

// Update Download Button Visual State
function updateDownloadButtonState(state) {
    if (state === 'idle') {
        downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="btn-icon-large">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            음성 파일로 다운로드 (.mp3)
        `;
        downloadBtn.style.opacity = "0.7";
    } else if (state === 'generating') {
        downloadBtn.innerHTML = `
            <div class="spinner-small"></div>
            음성 파일 생성 중...
        `;
        downloadBtn.style.opacity = "0.9";
    } else if (state === 'ready') {
        downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="btn-icon-large">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            음성 파일 다운로드 (.mp3)
        `;
        downloadBtn.style.opacity = "1";
    } else if (state === 'error') {
        downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon-large" style="color:var(--accent-red)">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            생성 실패 (재시도)
        `;
        downloadBtn.style.opacity = "1";
    }
}

// Queue background generation (non-blocking)
function queueBackgroundGeneration() {
    const text = textInput.value.trim();
    if (!text) {
        audioUrl = "";
        updateDownloadButtonState('idle');
        ttsGenerationPromise = null;
        return;
    }
    
    if (!isBackendAvailable) {
        // In offline/static mode, we don't pre-generate TTS
        audioUrl = "";
        updateDownloadButtonState('idle');
        ttsGenerationPromise = null;
        return;
    }
    
    audioUrl = "";
    updateDownloadButtonState('generating');
    
    const currentText = text;
    ttsGenerationPromise = fetch(`${API_BASE}/api/tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text: currentText
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('TTS generation failed');
        }
        return response.json();
    })
    .then(data => {
        // Ensure user hasn't edited the text since the request started
        if (textInput.value.trim() === currentText) {
            audioUrl = data.audioUrl;
            updateDownloadButtonState('ready');
        }
    })
    .catch(err => {
        console.error("Background TTS generation error:", err);
        if (textInput.value.trim() === currentText) {
            updateDownloadButtonState('error');
        }
    });
}

// TTS Playback Logic (Instant)
function play() {
    // 1. Resume if paused
    if (isPaused) {
        if (isBackendAvailable && activeAudio) {
            activeAudio.play();
            isPaused = false;
            isPlaying = true;
            playbackStateUI('playing');
            return;
        } else if (!isBackendAvailable && synth && synth.paused) {
            synth.resume();
            isPaused = false;
            isPlaying = true;
            playbackStateUI('playing');
            return;
        }
    }
    
    const text = textInput.value.trim();
    if (!text) {
        alert('읽을 텍스트를 입력해 주세요.');
        return;
    }
    
    // Stop any active playback first
    stop();
    
    // 2. Split text into sentences
    const sentences = splitTextIntoSentences(text);
    if (sentences.length === 0) {
        alert('필터링 후 읽을 수 있는 문장이 없습니다.');
        return;
    }
    
    isPlaying = true;
    isPaused = false;
    playbackStateUI('playing');
    
    if (isBackendAvailable) {
        // 3. Map to direct tts_single stream URLs
        chunks = sentences.map(sentence => {
            return {
                text: sentence,
                audioUrl: `${API_BASE}/api/tts_single?q=${encodeURIComponent(sentence)}&l=auto`
            };
        });
        
        // 4. Play the first chunk instantly
        playChunk(0);
    } else {
        // Web Speech API fallback
        chunks = sentences.map(sentence => {
            return {
                text: sentence
            };
        });
        playWebSpeechChunk(0);
    }
}

function playChunk(index) {
    if (!isPlaying) return;
    
    if (index >= chunks.length) {
        stop();
        return;
    }
    
    currentChunkIndex = index;
    const chunk = chunks[index];
    
    liveSubtitle.textContent = chunk.text;
    readingStatusText.textContent = `낭독 중 (${index + 1}/${chunks.length})`;
    updateProgress();
    
    if (activeAudio) {
        activeAudio.pause();
    }
    
    activeAudio = new Audio(chunk.audioUrl);
    activeAudio.volume = parseFloat(volumeRange.value);
    activeAudio.playbackRate = parseFloat(rateRange.value);
    
    activeAudio.onended = () => {
        playChunk(index + 1);
    };
    
    activeAudio.onerror = (e) => {
        console.error("Audio playback error on chunk", index, e);
        // Skip to next chunk on error
        playChunk(index + 1);
    };
    
    activeAudio.play().catch(err => {
        console.error("Playback start failed:", err);
        stop();
    });
}

function playWebSpeechChunk(index) {
    if (!isPlaying) return;
    
    if (index >= chunks.length) {
        stop();
        return;
    }
    
    currentChunkIndex = index;
    const chunk = chunks[index];
    
    liveSubtitle.textContent = chunk.text;
    readingStatusText.textContent = `낭독 중 (${index + 1}/${chunks.length}) [로컬엔진]`;
    updateProgress();
    
    if (currentUtterance) {
        synth.cancel();
    }
    
    currentUtterance = new SpeechSynthesisUtterance(chunk.text);
    
    // Simple language detection
    let hasKorean = false;
    for (let i = 0; i < chunk.text.length; i++) {
        const code = chunk.text.charCodeAt(i);
        if ((0xAC00 <= code && code <= 0xD7A3) || (0x3130 <= code && code <= 0x318F)) {
            hasKorean = true;
            break;
        }
    }
    currentUtterance.lang = hasKorean ? 'ko-KR' : 'en-US';
    
    currentUtterance.volume = parseFloat(volumeRange.value);
    currentUtterance.rate = parseFloat(rateRange.value);
    
    currentUtterance.onend = () => {
        if (isPlaying) {
            playWebSpeechChunk(index + 1);
        }
    };
    
    currentUtterance.onerror = (e) => {
        console.error("WebSpeech API error on chunk", index, e);
        if (isPlaying) {
            playWebSpeechChunk(index + 1);
        }
    };
    
    synth.speak(currentUtterance);
}

function pause() {
    if (!isPlaying || isPaused) return;
    
    if (isBackendAvailable && activeAudio) {
        activeAudio.pause();
    } else if (!isBackendAvailable && synth && synth.speaking) {
        synth.pause();
    }
    isPaused = true;
    isPlaying = false;
    playbackStateUI('paused');
}

function stop() {
    if (activeAudio) {
        activeAudio.pause();
        activeAudio = null;
    }
    if (synth) {
        synth.cancel();
    }
    isPlaying = false;
    isPaused = false;
    currentChunkIndex = -1;
    playbackStateUI('stopped');
}

// Download MP3 file directly
async function downloadAudio() {
    const text = textInput.value.trim();
    if (!text) {
        alert('다운로드할 텍스트를 입력해 주세요.');
        return;
    }
    
    if (!isBackendAvailable) {
        alert('음성 파일 다운로드 기능을 이용하시려면 로컬 백엔드 서버가 실행 중이어야 합니다.\n\n로컬 프로젝트 폴더의 "run.bat" 파일을 실행한 후 페이지를 다시 시도해 주세요.');
        return;
    }
    
    if (audioUrl) {
        triggerDownload(API_BASE + audioUrl);
        return;
    }
    
    // If background generation is currently active, show blocking loader and wait
    if (ttsGenerationPromise) {
        loaderTitle.textContent = "음성 파일 다운로드 준비 중...";
        loaderDesc.textContent = "백그라운드에서 진행 중인 음성 파일 생성을 마무리하고 있습니다. 잠시만 기다려 주세요.";
        loaderOverlay.classList.add('active');
        
        try {
            await ttsGenerationPromise;
            loaderOverlay.classList.remove('active');
            if (audioUrl) {
                triggerDownload(API_BASE + audioUrl);
            } else {
                alert('음성 파일 생성에 실패했습니다.');
            }
        } catch (e) {
            loaderOverlay.classList.remove('active');
            alert('음성 파일 생성에 실패했습니다: ' + e.message);
        }
        return;
    }
    
    // If it hasn't started generating (e.g. immediately clicked download after pasting)
    clearTimeout(debounceTimer);
    loaderTitle.textContent = "음성 파일 생성 중...";
    loaderDesc.textContent = "고음질 MP3 파일 다운로드를 위해 음성을 결합하고 있습니다. 잠시만 기다려 주세요.";
    loaderOverlay.classList.add('active');
    
    try {
        queueBackgroundGeneration();
        await ttsGenerationPromise;
        loaderOverlay.classList.remove('active');
        if (audioUrl) {
            triggerDownload(API_BASE + audioUrl);
        } else {
            alert('음성 파일 생성에 실패했습니다.');
        }
    } catch (e) {
        loaderOverlay.classList.remove('active');
        alert('음성 파일 생성에 실패했습니다: ' + e.message);
    }
}

function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `ClarityReader_음성_${Date.now()}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Range sliders real-time badge updates
rateRange.addEventListener('input', (e) => {
    rateValue.textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
    updateStats();
    if (isBackendAvailable && activeAudio && isPlaying) {
        activeAudio.playbackRate = parseFloat(e.target.value);
    }
});

volumeRange.addEventListener('input', (e) => {
    volumeValue.textContent = `${Math.round(e.target.value * 100)}%`;
    if (activeAudio) {
        activeAudio.volume = parseFloat(e.target.value);
    }
});

// Event Listeners for text input & settings change
textInput.addEventListener('input', () => {
    updateStats();
    
    // Reset state & invalidate URL
    audioUrl = "";
    updateDownloadButtonState('idle');
    
    // Debounce background auto-generation when typing
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        queueBackgroundGeneration();
    }, 1500); // 1.5 seconds of no typing triggers background TTS compilation
});

filterSpecialCheck.addEventListener('change', () => {
    updateStats();
    queueBackgroundGeneration(); // Re-trigger immediately on filter toggle
});

// Clipboard Paste Integration
pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        textInput.value = text;
        updateStats();
        queueBackgroundGeneration(); // Trigger background TTS instantly
    } catch (err) {
        alert('클립보드 읽기 권한이 필요하거나 지원되지 않는 브라우저입니다.');
    }
});

// Clear Text Integration
clearBtn.addEventListener('click', () => {
    textInput.value = '';
    stop();
    audioUrl = "";
    chunks = [];
    ttsGenerationPromise = null;
    clearTimeout(debounceTimer);
    updateStats();
});

// File Upload Integration
fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        loadTextFile(file);
    }
});

function loadTextFile(file) {
    if (file.type !== "text/plain" && !file.name.endsWith('.txt')) {
        alert('텍스트 파일(.txt)만 지원합니다.');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        textInput.value = e.target.result;
        stop();
        audioUrl = "";
        chunks = [];
        updateStats();
        queueBackgroundGeneration(); // Trigger background TTS instantly
    };
    reader.readAsText(file, 'UTF-8');
}

// Drag & Drop File Upload
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file) {
        loadTextFile(file);
    }
});

// Event Listeners for controls
playBtn.addEventListener('click', play);
pauseBtn.addEventListener('click', pause);
stopBtn.addEventListener('click', stop);
downloadBtn.addEventListener('click', downloadAudio);

// Initialize stats and backend connection status
(async () => {
    await checkBackendStatus();
    updateStats();
})();
