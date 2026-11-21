class MidiPlayer {
    constructor() {
        this.audioCtx = null;
        this.masterGain = null;
        this.reverbNode = null;
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
        this.spectrumBins = new Array(32).fill(0);
        this.onProgress = null;
        this.onStateChange = null;
    }

    initCanvas(canvasEl) {
        this.canvas = canvasEl;
        this.canvasCtx = canvasEl.getContext("2d");
        this.startVisualizer();
    }

    createConcertHallImpulse() {
        if (!this.audioCtx) return null;
        const rate = this.audioCtx.sampleRate;
        const length = Math.floor(rate * 1.8);
        const buffer = this.audioCtx.createBuffer(2, length, rate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const decay = Math.exp(-i / (rate * 0.45));
            left[i] = (Math.random() * 2 - 1) * decay;
            right[i] = (Math.random() * 2 - 1) * decay;
        }
        return buffer;
    }

    ensureAudioContext() {
        if (!this.audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContextClass();

            this.masterGain = this.audioCtx.createGain();
            this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);

            this.reverbNode = this.audioCtx.createConvolver();
            this.reverbNode.buffer = this.createConcertHallImpulse();

            const reverbGain = this.audioCtx.createGain();
            reverbGain.gain.setValueAtTime(0.28, this.audioCtx.currentTime);

            this.reverbNode.connect(reverbGain);
            reverbGain.connect(this.masterGain);
            this.masterGain.connect(this.audioCtx.destination);
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
        let tempoMicros = 544000;
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
                    } else {
                        const cmd = status & 0xf0;
                        const ch = status & 0x0f;

                        if (cmd === 0x90) {
                            if (offset + 1 >= bytes.length) break;
                            const pitch = bytes[offset++];
                            const velocity = bytes[offset++];
                            if (velocity > 0) {
                                activeNotesMap.set(pitch, { tick: currentTick, velocity, channel: ch });
                            } else if (activeNotesMap.has(pitch)) {
                                const start = activeNotesMap.get(pitch);
                                activeNotesMap.delete(pitch);
                                totalCount++;
                                if (notes.length < 150000) {
                                    notes.push({
                                        pitch,
                                        channel: start.channel !== undefined ? start.channel : ch,
                                        startTick: start.tick,
                                        durTicks: Math.max(currentTick - start.tick, 40),
                                        velocity: start.velocity
                                    });
                                }
                            }
                        } else if (cmd === 0x80) {
                            if (offset + 1 >= bytes.length) break;
                            const pitch = bytes[offset++];
                            offset++;
                            if (activeNotesMap.has(pitch)) {
                                const start = activeNotesMap.get(pitch);
                                activeNotesMap.delete(pitch);
                                totalCount++;
                                if (notes.length < 150000) {
                                    notes.push({
                                        pitch,
                                        channel: start.channel !== undefined ? start.channel : ch,
                                        startTick: start.tick,
                                        durTicks: Math.max(currentTick - start.tick, 40),
                                        velocity: start.velocity
                                    });
                                }
                            }
                        } else if (cmd === 0xc0 || cmd === 0xd0) {
                            offset++;
                        } else if (cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
                            offset += 2;
                        }
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
            channel: n.channel !== undefined ? n.channel : 0,
            startSec: n.startTick * secPerTick,
            durSec: Math.max(n.durTicks * secPerTick, 0.08),
            velocity: n.velocity / 127
        }));

        const totalSec = parsed.length > 0
            ? parsed.reduce((m, n) => Math.max(m, n.startSec + n.durSec), 0)
            : Math.max(totalCount * 0.25, 0.5);

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
        if (this.masterGain && this.audioCtx) {
            this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
        }
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

        const lookAheadSec = 0.14;
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

    getVoiceType(note) {
        if (note.channel !== undefined && note.channel >= 0) {
            return note.channel % 4;
        }
        if (note.pitch < 50) return 0;
        if (note.pitch < 64) return 1;
        if (note.pitch < 76) return 2;
        return 3;
    }

    synthesizeNote(note, startTime) {
        const ctx = this.audioCtx;
        const now = ctx.currentTime;
        const scheduleAt = Math.max(startTime, now);
        const freq = 440 * Math.pow(2, (note.pitch - 69) / 12);
        const duration = Math.min(note.durSec, 3.2);
        const voiceType = this.getVoiceType(note);

        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        filter.connect(gain);
        gain.connect(this.masterGain);
        if (this.reverbNode) {
            gain.connect(this.reverbNode);
        }

        let osc1 = null;
        let osc2 = null;
        let osc3 = null;
        let vibOsc = null;
        let vibGain = null;

        if (voiceType === 0) {
            osc1 = ctx.createOscillator();
            osc2 = ctx.createOscillator();
            osc1.type = "sawtooth";
            osc1.frequency.setValueAtTime(freq, scheduleAt);

            osc2.type = "sine";
            osc2.frequency.setValueAtTime(freq > 55 ? freq * 0.5 : freq, scheduleAt);

            filter.type = "lowpass";
            filter.frequency.setValueAtTime(Math.min(freq * 3.2, 1200), scheduleAt);
            filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 140), scheduleAt + duration);
            filter.Q.setValueAtTime(2.6, scheduleAt);

            const peakGain = note.velocity * 0.22;
            gain.gain.setValueAtTime(0, scheduleAt);
            gain.gain.linearRampToValueAtTime(peakGain, scheduleAt + 0.05);
            gain.gain.exponentialRampToValueAtTime(peakGain * 0.8, scheduleAt + 0.18);
            gain.gain.exponentialRampToValueAtTime(0.0001, scheduleAt + duration);

            osc1.connect(filter);
            osc2.connect(filter);
            osc1.start(scheduleAt);
            osc2.start(scheduleAt);
            osc1.stop(scheduleAt + duration);
            osc2.stop(scheduleAt + duration);
        } else if (voiceType === 1) {
            osc1 = ctx.createOscillator();
            osc2 = ctx.createOscillator();
            osc3 = ctx.createOscillator();

            osc1.type = "sawtooth";
            osc2.type = "sawtooth";
            osc3.type = "sine";

            osc1.frequency.setValueAtTime(freq * 1.005, scheduleAt);
            osc2.frequency.setValueAtTime(freq * 0.995, scheduleAt);
            osc3.frequency.setValueAtTime(freq, scheduleAt);

            filter.type = "lowpass";
            filter.frequency.setValueAtTime(Math.min(freq * 3.8, 2800), scheduleAt);
            filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.8, 300), scheduleAt + duration);
            filter.Q.setValueAtTime(1.2, scheduleAt);

            const peakGain = note.velocity * 0.16;
            gain.gain.setValueAtTime(0, scheduleAt);
            gain.gain.linearRampToValueAtTime(peakGain, scheduleAt + 0.08);
            gain.gain.exponentialRampToValueAtTime(peakGain * 0.85, scheduleAt + 0.25);
            gain.gain.exponentialRampToValueAtTime(0.0001, scheduleAt + duration);

            osc1.connect(filter);
            osc2.connect(filter);
            osc3.connect(filter);
            osc1.start(scheduleAt);
            osc2.start(scheduleAt);
            osc3.start(scheduleAt);
            osc1.stop(scheduleAt + duration);
            osc2.stop(scheduleAt + duration);
            osc3.stop(scheduleAt + duration);
        } else if (voiceType === 2) {
            osc1 = ctx.createOscillator();
            osc2 = ctx.createOscillator();
            vibOsc = ctx.createOscillator();
            vibGain = ctx.createGain();

            osc1.type = "triangle";
            osc2.type = "sawtooth";

            vibOsc.frequency.setValueAtTime(5.4, scheduleAt);
            vibGain.gain.setValueAtTime(3.8, scheduleAt);
            vibOsc.connect(vibGain);
            vibGain.connect(osc1.frequency);
            vibGain.connect(osc2.frequency);

            osc1.frequency.setValueAtTime(freq, scheduleAt);
            osc2.frequency.setValueAtTime(freq, scheduleAt);

            filter.type = "bandpass";
            filter.frequency.setValueAtTime(Math.min(freq * 2.2, 3400), scheduleAt);
            filter.Q.setValueAtTime(1.8, scheduleAt);

            const peakGain = note.velocity * 0.18;
            gain.gain.setValueAtTime(0, scheduleAt);
            gain.gain.linearRampToValueAtTime(peakGain, scheduleAt + 0.025);
            gain.gain.exponentialRampToValueAtTime(peakGain * 0.75, scheduleAt + 0.12);
            gain.gain.exponentialRampToValueAtTime(0.0001, scheduleAt + duration);

            osc1.connect(filter);
            osc2.connect(filter);
            vibOsc.start(scheduleAt);
            osc1.start(scheduleAt);
            osc2.start(scheduleAt);
            vibOsc.stop(scheduleAt + duration);
            osc1.stop(scheduleAt + duration);
            osc2.stop(scheduleAt + duration);
        } else {
            osc1 = ctx.createOscillator();
            osc2 = ctx.createOscillator();
            osc3 = ctx.createOscillator();

            osc1.type = "sine";
            osc2.type = "triangle";
            osc3.type = "sine";

            osc1.frequency.setValueAtTime(freq, scheduleAt);
            osc2.frequency.setValueAtTime(freq * 2, scheduleAt);
            osc3.frequency.setValueAtTime(freq * 3, scheduleAt);

            filter.type = "lowpass";
            filter.frequency.setValueAtTime(Math.min(freq * 4.5, 6000), scheduleAt);
            filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.2, 500), scheduleAt + duration);
            filter.Q.setValueAtTime(0.9, scheduleAt);

            const peakGain = note.velocity * 0.19;
            gain.gain.setValueAtTime(0, scheduleAt);
            gain.gain.linearRampToValueAtTime(peakGain, scheduleAt + 0.005);
            gain.gain.exponentialRampToValueAtTime(peakGain * 0.35, scheduleAt + 0.09);
            gain.gain.exponentialRampToValueAtTime(0.0001, scheduleAt + Math.min(duration, 0.45));

            osc1.connect(filter);
            osc2.connect(filter);
            osc3.connect(filter);
            osc1.start(scheduleAt);
            osc2.start(scheduleAt);
            osc3.start(scheduleAt);
            osc1.stop(scheduleAt + duration);
            osc2.stop(scheduleAt + duration);
            osc3.stop(scheduleAt + duration);
        }

        const triggerDelay = Math.max(0, (scheduleAt - now) * 1000);
        setTimeout(() => {
            if (this.isPlaying) {
                this.triggerVisualNote(note.pitch, note.velocity, voiceType);
            }
        }, triggerDelay);

        setTimeout(() => {
            this.activePitches.delete(note.pitch);
        }, triggerDelay + duration * 1000);

        this.activeNodes.push({ osc1, osc2, osc3, vibOsc, gain });
        if (this.activeNodes.length > 80) {
            this.activeNodes.shift();
        }
    }

    stopActiveNodes() {
        for (const item of this.activeNodes) {
            try {
                item.gain.gain.cancelScheduledValues(0);
                item.gain.gain.setValueAtTime(0, 0);
                if (item.osc1) item.osc1.stop();
                if (item.osc2) item.osc2.stop();
                if (item.osc3) item.osc3.stop();
                if (item.vibOsc) item.vibOsc.stop();
            } catch (e) {}
        }
        this.activeNodes = [];
    }

    triggerVisualNote(pitch, velocity, voiceType) {
        this.activePitches.add(pitch);
        const binIdx = Math.min(Math.max(0, Math.floor((pitch - 28) * (this.spectrumBins.length / 76))), this.spectrumBins.length - 1);
        this.spectrumBins[binIdx] = Math.min(1.0, this.spectrumBins[binIdx] + velocity * 1.3);

        if (this.canvas) {
            const x = (binIdx / this.spectrumBins.length) * this.canvas.width + 12;
            const colors = [
                "rgba(245, 158, 11, ",
                "rgba(16, 185, 129, ",
                "rgba(14, 165, 233, ",
                "rgba(168, 85, 247, "
            ];
            const voiceColor = colors[voiceType !== undefined ? voiceType : (binIdx % 4)];
            this.ripples.push({
                x,
                y: this.canvas.height * 0.5,
                radius: 4,
                alpha: 0.95,
                color: voiceColor
            });
            if (this.ripples.length > 28) this.ripples.shift();
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
        grad.addColorStop(0, "rgba(2, 44, 34, 0.75)");
        grad.addColorStop(1, "rgba(6, 78, 59, 0.9)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        const numBars = this.spectrumBins.length;
        const barWidth = (w / numBars) - 2.5;

        for (let i = 0; i < numBars; i++) {
            this.spectrumBins[i] *= 0.91;
            const val = this.spectrumBins[i];
            const barH = Math.max(3, val * (h - 22));
            const x = i * (barWidth + 2.5) + 2;
            const y = h - barH - 8;

            const q = i / numBars;
            const barGrad = ctx.createLinearGradient(0, y, 0, h);
            if (q < 0.25) {
                barGrad.addColorStop(0, "rgba(254, 243, 199, 0.98)");
                barGrad.addColorStop(0.3, "rgba(245, 158, 11, 0.9)");
                barGrad.addColorStop(1, "rgba(180, 83, 9, 0.4)");
            } else if (q < 0.5) {
                barGrad.addColorStop(0, "rgba(209, 250, 229, 0.98)");
                barGrad.addColorStop(0.3, "rgba(16, 185, 129, 0.9)");
                barGrad.addColorStop(1, "rgba(4, 120, 87, 0.4)");
            } else if (q < 0.75) {
                barGrad.addColorStop(0, "rgba(224, 242, 254, 0.98)");
                barGrad.addColorStop(0.3, "rgba(14, 165, 233, 0.9)");
                barGrad.addColorStop(1, "rgba(3, 105, 161, 0.4)");
            } else {
                barGrad.addColorStop(0, "rgba(243, 232, 255, 0.98)");
                barGrad.addColorStop(0.3, "rgba(168, 85, 247, 0.9)");
                barGrad.addColorStop(1, "rgba(109, 40, 217, 0.4)");
            }

            ctx.fillStyle = barGrad;
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barH, [4, 4, 1, 1]);
            ctx.fill();

            ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
            ctx.fillRect(x, y, barWidth, 2);
        }

        for (let i = this.ripples.length - 1; i >= 0; i--) {
            const r = this.ripples[i];
            r.radius += 2.0;
            r.alpha *= 0.93;
            if (r.alpha < 0.02) {
                this.ripples.splice(i, 1);
                continue;
            }
            ctx.strokeStyle = r.color + r.alpha + ")";
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        const shineGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        shineGrad.addColorStop(0, "rgba(255, 255, 255, 0.22)");
        shineGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = shineGrad;
        ctx.fillRect(0, 0, w, h * 0.45);
    }
}

window.midiPlayer = new MidiPlayer();
