class MidiPlayer {
    constructor() {
        this.audioCtx = null;
        this.notes = [];
        this.totalDuration = 0;
        this.totalNotesCount = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartTime = 0;
        this.pauseOffset = 0;
        this.schedulerTimer = null;
        this.activeNoteIndex = 0;
        this.activeNodes = [];
        this.activePitches = new Set();
        this.volume = 0.8;
        this.canvas = null;
        this.canvasCtx = null;
        this.animFrameId = null;
        this.ripples = [];
        this.spectrumBins = new Array(24).fill(0);
        this.onProgress = null;
        this.onStateChange = null;
    }

    initCanvas(canvasEl) {
        this.canvas = canvasEl;
        this.canvasCtx = canvasEl.getContext("2d");
        this.startVisualizer();
    }

    ensureAudioContext() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContextClass();
        }
        if (this.audioCtx.state === "suspended") {
            this.audioCtx.resume();
        }
    }

    parseMidiBytes(bytes) {
        const magic = String.fromCharCode(...bytes.slice(0, 4));
        if (magic !== "MThd") {
            throw new Error("Invalid MIDI header");
        }

        const division = (bytes[12] << 8) | bytes[13];
        const ppq = division > 0 ? division : 480;
        const notes = [];
        let offset = 14;
        let tempoMicros = 500000;
        let totalCount = 0;

        while (offset + 8 <= bytes.length) {
            const chunkType = String.fromCharCode(...bytes.slice(offset, offset + 4));
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const chunkLen = view.getUint32(offset + 4, false);
            offset += 8;

            if (chunkType === "MTrk") {
                const trackEnd = Math.min(offset + chunkLen, bytes.length);
                let currentTick = 0;
                const activeNotesMap = new Map();

                while (offset < trackEnd && offset < bytes.length) {
                    let vlqVal = 0;
                    let b;
                    do {
                        if (offset >= bytes.length) break;
                        b = bytes[offset++];
                        vlqVal = (vlqVal << 7) | (b & 0x7f);
                    } while (b & 0x80);

                    if (offset >= bytes.length) break;
                    currentTick += vlqVal;
                    const status = bytes[offset++];

                    if (status === 0xff) {
                        if (offset >= bytes.length) break;
                        const metaType = bytes[offset++];
                        let metaLen = 0;
                        do {
                            if (offset >= bytes.length) break;
                            b = bytes[offset++];
                            metaLen = (metaLen << 7) | (b & 0x7f);
                        } while (b & 0x80);

                        if (metaType === 0x51 && metaLen === 3 && offset + 3 <= bytes.length) {
                            tempoMicros = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
                        }
                        offset += metaLen;
                        if (metaType === 0x2f) break;
                    } else if ((status & 0xf0) === 0x90) {
                        if (offset + 1 >= bytes.length) break;
                        const pitch = bytes[offset++];
                        const velocity = bytes[offset++];
                        if (velocity > 0) {
                            activeNotesMap.set(pitch, { tick: currentTick, velocity });
                        } else if (activeNotesMap.has(pitch)) {
                            const start = activeNotesMap.get(pitch);
                            activeNotesMap.delete(pitch);
                            totalCount++;
                            if (notes.length < 50000) {
                                notes.push({
                                    pitch,
                                    startTick: start.tick,
                                    durTicks: Math.max(currentTick - start.tick, 60),
                                    velocity: start.velocity
                                });
                            }
                        }
                    } else if ((status & 0xf0) === 0x80) {
                        if (offset + 1 >= bytes.length) break;
                        const pitch = bytes[offset++];
                        offset++;
                        if (activeNotesMap.has(pitch)) {
                            const start = activeNotesMap.get(pitch);
                            activeNotesMap.delete(pitch);
                            totalCount++;
                            if (notes.length < 50000) {
                                notes.push({
                                    pitch,
                                    startTick: start.tick,
                                    durTicks: Math.max(currentTick - start.tick, 60),
                                    velocity: start.velocity
                                });
                            }
                        }
                    } else if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) {
                        offset++;
                    } else if ((status & 0xf0) === 0xa0 || (status & 0xf0) === 0xb0 || (status & 0xf0) === 0xe0) {
                        offset += 2;
                    }
                }
            } else {
                offset = Math.min(offset + chunkLen, bytes.length);
            }
        }

        const secPerTick = (tempoMicros / 1000000) / ppq;
        notes.sort((a, b) => a.startTick - b.startTick);

        const parsed = notes.map(n => ({
            pitch: n.pitch,
            startSec: n.startTick * secPerTick,
            durSec: Math.max(n.durTicks * secPerTick, 0.08),
            velocity: n.velocity / 127
        }));

        const totalSec = parsed.length > 0 ? parsed.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0) : Math.max(totalCount * 0.25, 0.5);
        return { notes: parsed, duration: Math.max(totalSec, 0.5), count: totalCount || parsed.length };
    }

    loadMidi(bytes, overrideCount) {
        this.stop();
        const { notes, duration, count } = this.parseMidiBytes(bytes);
        this.notes = notes;
        this.totalDuration = duration;
        this.totalNotesCount = overrideCount || count;
        this.pauseOffset = 0;
        this.activeNoteIndex = 0;
        if (this.onProgress) {
            this.onProgress(0, this.totalDuration);
        }
        if (this.onStateChange) {
            this.onStateChange("loaded", this);
        }
    }

    play() {
        if (!this.notes.length) return;
        this.ensureAudioContext();

        if (this.isPaused) {
            this.playbackStartTime = this.audioCtx.currentTime - this.pauseOffset;
            this.isPaused = false;
        } else {
            this.stopActiveNodes();
            this.playbackStartTime = this.audioCtx.currentTime - this.pauseOffset;
            this.activeNoteIndex = this.findNoteIndexAt(this.pauseOffset);
        }

        this.isPlaying = true;
        if (this.onStateChange) this.onStateChange("playing", this);

        clearInterval(this.schedulerTimer);
        this.schedulerTimer = setInterval(() => this.scheduleUpcomingNotes(), 25);
    }

    pause() {
        if (!this.isPlaying) return;
        this.isPaused = true;
        this.isPlaying = false;
        clearInterval(this.schedulerTimer);
        this.pauseOffset = this.getCurrentTime();
        this.stopActiveNodes();
        if (this.onStateChange) this.onStateChange("paused", this);
    }

    stop() {
        this.isPlaying = false;
        this.isPaused = false;
        clearInterval(this.schedulerTimer);
        this.pauseOffset = 0;
        this.activeNoteIndex = 0;
        this.activePitches.clear();
        this.stopActiveNodes();
        if (this.onProgress) this.onProgress(0, this.totalDuration);
        if (this.onStateChange) this.onStateChange("stopped", this);
    }

    seek(seconds) {
        const wasPlaying = this.isPlaying;
        if (this.isPlaying) {
            this.pause();
        }
        this.pauseOffset = Math.max(0, Math.min(seconds, this.totalDuration));
        this.activeNoteIndex = this.findNoteIndexAt(this.pauseOffset);
        if (this.onProgress) {
            this.onProgress(this.pauseOffset, this.totalDuration);
        }
        if (wasPlaying) {
            this.play();
        }
    }

    setVolume(val) {
        this.volume = Math.max(0, Math.min(1, val));
    }

    getCurrentTime() {
        if (!this.audioCtx) return this.pauseOffset;
        if (this.isPlaying) {
            const t = this.audioCtx.currentTime - this.playbackStartTime;
            return Math.max(0, Math.min(t, this.totalDuration));
        }
        return this.pauseOffset;
    }

    findNoteIndexAt(timeSec) {
        let low = 0;
        let high = this.notes.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.notes[mid].startSec < timeSec) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return Math.max(0, low);
    }

    scheduleUpcomingNotes() {
        if (!this.isPlaying) return;

        const currentSongTime = this.getCurrentTime();
        if (this.onProgress) {
            this.onProgress(currentSongTime, this.totalDuration);
        }

        if (currentSongTime >= this.totalDuration) {
            this.stop();
            return;
        }

        const lookAheadSec = 0.12;
        const horizon = currentSongTime + lookAheadSec;

        while (this.activeNoteIndex < this.notes.length) {
            const note = this.notes[this.activeNoteIndex];
            if (note.startSec > horizon) break;

            if (note.startSec + note.durSec > currentSongTime) {
                const noteAudioStart = this.playbackStartTime + note.startSec;
                if (noteAudioStart >= this.audioCtx.currentTime - 0.02) {
                    this.synthesizeNote(note, noteAudioStart);
                }
            }
            this.activeNoteIndex++;
        }
    }

    synthesizeNote(note, startTime) {
        const ctx = this.audioCtx;
        const now = ctx.currentTime;
        const scheduleAt = Math.max(startTime, now);
        const freq = 440 * Math.pow(2, (note.pitch - 69) / 12);
        const duration = Math.min(note.durSec, 2.5);

        const osc = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, scheduleAt);

        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(freq * 2, scheduleAt);

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(freq * 4, scheduleAt);
        filter.frequency.exponentialRampToValueAtTime(freq * 1.5, scheduleAt + duration);

        const peakGain = note.velocity * this.volume * 0.28;
        gain.gain.setValueAtTime(0, scheduleAt);
        gain.gain.linearRampToValueAtTime(peakGain, scheduleAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(peakGain * 0.6, scheduleAt + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.0001, scheduleAt + duration);

        osc.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(scheduleAt);
        osc2.start(scheduleAt);
        osc.stop(scheduleAt + duration);
        osc2.stop(scheduleAt + duration);

        const triggerDelay = Math.max(0, (scheduleAt - now) * 1000);
        setTimeout(() => {
            if (this.isPlaying) {
                this.triggerVisualNote(note.pitch, note.velocity);
            }
        }, triggerDelay);

        setTimeout(() => {
            this.activePitches.delete(note.pitch);
        }, triggerDelay + duration * 1000);

        this.activeNodes.push({ osc, osc2, gain });
        if (this.activeNodes.length > 60) {
            this.activeNodes.shift();
        }
    }

    stopActiveNodes() {
        for (const item of this.activeNodes) {
            try {
                item.gain.gain.cancelScheduledValues(0);
                item.gain.gain.setValueAtTime(0, 0);
                item.osc.stop();
                item.osc2.stop();
            } catch (e) {}
        }
        this.activeNodes = [];
    }

    triggerVisualNote(pitch, velocity) {
        this.activePitches.add(pitch);
        const binIdx = Math.min(Math.max(0, pitch - 48), this.spectrumBins.length - 1);
        this.spectrumBins[binIdx] = Math.min(1.0, this.spectrumBins[binIdx] + velocity * 1.2);

        if (this.canvas) {
            const x = (binIdx / this.spectrumBins.length) * this.canvas.width + 12;
            this.ripples.push({
                x,
                y: this.canvas.height * 0.5,
                radius: 4,
                alpha: 0.9,
                color: binIdx % 2 === 0 ? "rgba(52, 211, 153, " : "rgba(56, 189, 248, "
            });
            if (this.ripples.length > 20) this.ripples.shift();
        }
    }

    startVisualizer() {
        const render = () => {
            this.drawFrame();
            this.animFrameId = requestAnimationFrame(render);
        };
        this.animFrameId = requestAnimationFrame(render);
    }

    drawFrame() {
        if (!this.canvas || !this.canvasCtx) return;
        const ctx = this.canvasCtx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(6, 78, 59, 0.45)");
        grad.addColorStop(1, "rgba(2, 44, 34, 0.7)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        const numBars = this.spectrumBins.length;
        const barWidth = (w / numBars) - 3;

        for (let i = 0; i < numBars; i++) {
            this.spectrumBins[i] *= 0.92;
            const val = this.spectrumBins[i];
            const barH = Math.max(3, val * (h - 20));
            const x = i * (barWidth + 3) + 2;
            const y = h - barH - 8;

            const barGrad = ctx.createLinearGradient(0, y, 0, h);
            barGrad.addColorStop(0, "rgba(255, 255, 255, 0.95)");
            barGrad.addColorStop(0.2, "rgba(110, 231, 183, 0.9)");
            barGrad.addColorStop(0.6, "rgba(52, 211, 153, 0.75)");
            barGrad.addColorStop(1, "rgba(14, 165, 233, 0.4)");

            ctx.fillStyle = barGrad;
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barH, [4, 4, 1, 1]);
            ctx.fill();

            ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
            ctx.fillRect(x, y, barWidth, 2);
        }

        for (let i = this.ripples.length - 1; i >= 0; i--) {
            const r = this.ripples[i];
            r.radius += 1.8;
            r.alpha *= 0.94;
            if (r.alpha < 0.02) {
                this.ripples.splice(i, 1);
                continue;
            }
            ctx.strokeStyle = r.color + r.alpha + ")";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        const shineGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        shineGrad.addColorStop(0, "rgba(255, 255, 255, 0.25)");
        shineGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = shineGrad;
        ctx.fillRect(0, 0, w, h * 0.45);
    }
}

window.midiPlayer = new MidiPlayer();
