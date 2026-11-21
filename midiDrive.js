const MAGIC = new TextEncoder().encode("MIDI");

const SCALE = [
    48, 50, 52, 55, 57,
    60, 62, 64, 67, 69,
    72, 74, 76, 79, 81,
    84
];

const DURATIONS_LEGACY = [120, 240, 480, 960];
const VELOCITIES_LEGACY = [45, 70, 95, 120];

const CHORDS = [
    {
        bass: [36, 38, 40, 41, 43, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60, 62],
        harmony: [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74],
        melody: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86],
        harp: [72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 89, 91, 93, 95, 96, 98]
    },
    {
        bass: [33, 35, 36, 38, 40, 41, 43, 45, 47, 48, 50, 52, 53, 55, 57, 60],
        harmony: [45, 47, 48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 72],
        melody: [57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 84],
        harp: [69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 89, 91, 93, 96]
    },
    {
        bass: [29, 33, 36, 38, 41, 43, 45, 47, 48, 50, 53, 55, 57, 60, 62, 65],
        harmony: [41, 45, 48, 50, 53, 55, 57, 59, 60, 62, 65, 67, 69, 71, 72, 74],
        melody: [53, 57, 60, 62, 65, 67, 69, 71, 72, 74, 77, 79, 81, 83, 84, 86],
        harp: [65, 69, 72, 74, 77, 79, 81, 83, 84, 86, 89, 91, 93, 95, 96, 98]
    },
    {
        bass: [31, 35, 38, 41, 43, 45, 47, 48, 50, 53, 55, 57, 59, 62, 65, 67],
        harmony: [43, 47, 50, 53, 55, 57, 59, 60, 62, 65, 67, 69, 71, 74, 77, 79],
        melody: [55, 59, 62, 65, 67, 69, 71, 72, 74, 77, 79, 81, 83, 86, 89, 91],
        harp: [67, 71, 74, 77, 79, 81, 83, 84, 86, 89, 91, 93, 95, 98, 101, 103]
    }
];

const VELOCITIES = [50, 75, 95, 115];

const DURATIONS = {
    bass: [720, 960, 1200, 1440],
    harmony: [600, 840, 1080, 1320],
    melody: [240, 360, 480, 600],
    harp: [180, 240, 300, 360]
};

const REST_DELAYS = {
    bass: [240, 480, 720, 960],
    harmony: [120, 240, 360, 480],
    melody: [120, 180, 240, 360],
    harp: [240, 360, 480, 600]
};

const TRACK_SLOTS = [
    [ { s: 0, part: "bass" } ],
    [ { s: 1, part: "harmony" }, { s: 2, part: "harmony" } ],
    [ { s: 3, part: "melody" }, { s: 4, part: "melody" }, { s: 5, part: "melody" } ],
    [ { s: 6, part: "harp" }, { s: 7, part: "harp" } ]
];

const TRACK_SLOT_PARTS = [
    ["bass"],
    ["harmony", "harmony"],
    ["melody", "melody", "melody"],
    ["harp", "harp"]
];

const PROGRAMS = [42, 48, 40, 46];

function packFile(filename, fileBytes) {
    const nameBytes = new TextEncoder().encode(filename);
    if (nameBytes.length > 255) throw new Error("Filename too long (max 255 bytes)");

    const out = new Uint8Array(9 + nameBytes.length + fileBytes.length);
    const view = new DataView(out.buffer);

    out.set(MAGIC, 0);
    view.setUint8(4, nameBytes.length);
    view.setUint32(5, fileBytes.length, false);
    out.set(nameBytes, 9);
    out.set(fileBytes, 9 + nameBytes.length);

    return out;
}

function unpackFileHeader(bytes) {
    for (let i = 0; i < 4; i++) {
        if (bytes[i] !== MAGIC[i]) throw new Error("Not a valid MIDI-Drive file!");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLen = view.getUint8(4);
    const dataLen = view.getUint32(5, false);
    const name = new TextDecoder().decode(bytes.slice(9, 9 + nameLen));
    return { name, nameLen, dataLen, offset: 9 + nameLen };
}

function writeVLQ(n) {
    const bytes = [n & 0x7f];
    while ((n >>= 7) > 0) {
        bytes.unshift((n & 0x7f) | 0x80);
    }
    return bytes;
}

function readVLQ(bytes, offset) {
    let value = 0;
    let byte;
    do {
        byte = bytes[offset++];
        value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return { value, offset };
}

async function encodeToMidi(blob, onProgress, mode = "polyphonic") {
    if (mode === "legacy") {
        return encodeLegacyToMidi(blob, onProgress);
    }
    return encodePolyphonicToMidi(blob, onProgress);
}

async function encodeLegacyToMidi(blob, onProgress) {
    const total = blob.length;
    let trackLen = 7 + 4;
    for (let i = 0; i < total; i++) {
        trackLen += ((blob[i] >> 2) & 0x03) === 0 ? 8 : 9;
    }

    const CHUNK_SIZE = 2 * 1024 * 1024;
    const chunks = [];

    const headerBuf = new Uint8Array(22);
    headerBuf.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0], 0);
    headerBuf.set([0x4d, 0x54, 0x72, 0x6b, (trackLen >>> 24) & 0xff, (trackLen >>> 16) & 0xff, (trackLen >>> 8) & 0xff, trackLen & 0xff], 14);
    chunks.push(headerBuf);

    let chunk = new Uint8Array(CHUNK_SIZE);
    let chunkPos = 0;

    chunk[chunkPos++] = 0x00;
    chunk[chunkPos++] = 0xff;
    chunk[chunkPos++] = 0x51;
    chunk[chunkPos++] = 0x03;
    chunk[chunkPos++] = 0x07;
    chunk[chunkPos++] = 0xa1;
    chunk[chunkPos++] = 0x20;

    let lastProgressTime = Date.now();

    for (let i = 0; i < total; i++) {
        if (chunkPos + 10 >= CHUNK_SIZE) {
            chunks.push(chunk.subarray(0, chunkPos));
            chunk = new Uint8Array(CHUNK_SIZE);
            chunkPos = 0;
        }

        const b = blob[i];
        const pitch = SCALE[(b >> 4) & 0x0f];
        const durIdx = (b >> 2) & 0x03;
        const duration = DURATIONS_LEGACY[durIdx];
        const velocity = VELOCITIES_LEGACY[b & 0x03];

        chunk[chunkPos++] = 0x00;
        chunk[chunkPos++] = 0x90;
        chunk[chunkPos++] = pitch;
        chunk[chunkPos++] = velocity;

        if (duration < 128) {
            chunk[chunkPos++] = duration;
        } else {
            chunk[chunkPos++] = (duration >> 7) | 0x80;
            chunk[chunkPos++] = duration & 0x7f;
        }

        chunk[chunkPos++] = 0x80;
        chunk[chunkPos++] = pitch;
        chunk[chunkPos++] = 0x00;

        if (onProgress && Date.now() - lastProgressTime > 50) {
            const pct = Math.round((i / total) * 100);
            onProgress(pct);
            lastProgressTime = Date.now();
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (chunkPos + 4 >= CHUNK_SIZE) {
        chunks.push(chunk.subarray(0, chunkPos));
        chunk = new Uint8Array(CHUNK_SIZE);
        chunkPos = 0;
    }
    chunk[chunkPos++] = 0x00;
    chunk[chunkPos++] = 0xff;
    chunk[chunkPos++] = 0x2f;
    chunk[chunkPos++] = 0x00;

    if (chunkPos > 0) {
        chunks.push(chunk.subarray(0, chunkPos));
    }

    if (onProgress) onProgress(100);
    return new Blob(chunks, { type: "audio/midi" });
}

async function encodePolyphonicToMidi(blob, onProgress) {
    const total = blob.length;
    const totalChunks = Math.ceil(total / 8);
    const chunks = [];

    const headerBuf = new Uint8Array(14);
    headerBuf.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x04, 0x01, 0xe0], 0);
    chunks.push(headerBuf);

    let lastProgressTime = Date.now();
    const CHUNK_SIZE = 2 * 1024 * 1024;

    for (let t = 0; t < 4; t++) {
        const slots = TRACK_SLOTS[t];
        const numSlots = slots.length;

        let trkDataLen = (t === 0 ? 7 : 0) + 3 + 4;
        let isFirstNote = true;
        for (let m = 0; m < totalChunks; m++) {
            for (let si = 0; si < numSlots; si++) {
                const idx = m * 8 + slots[si].s;
                if (idx >= total) break;
                const durIdx = (blob[idx] >> 2) & 0x03;
                const duration = DURATIONS[slots[si].part][durIdx];
                const restDelay = isFirstNote ? (t * 120) : REST_DELAYS[slots[si].part][durIdx];
                isFirstNote = false;
                const durVlqLen = duration < 128 ? 1 : 2;
                const delayVlqLen = restDelay < 128 ? 1 : 2;
                trkDataLen += delayVlqLen + 3 + durVlqLen + 3;
            }
        }

        const trkHeader = new Uint8Array(8);
        trkHeader.set([
            0x4d, 0x54, 0x72, 0x6b,
            (trkDataLen >>> 24) & 0xff,
            (trkDataLen >>> 16) & 0xff,
            (trkDataLen >>> 8) & 0xff,
            trkDataLen & 0xff
        ], 0);
        chunks.push(trkHeader);

        let chunk = new Uint8Array(CHUNK_SIZE);
        let chunkPos = 0;

        if (t === 0) {
            chunk[chunkPos++] = 0x00;
            chunk[chunkPos++] = 0xff;
            chunk[chunkPos++] = 0x51;
            chunk[chunkPos++] = 0x03;
            chunk[chunkPos++] = 0x08;
            chunk[chunkPos++] = 0x4d;
            chunk[chunkPos++] = 0x00;
        }

        chunk[chunkPos++] = 0x00;
        chunk[chunkPos++] = 0xc0 | t;
        chunk[chunkPos++] = PROGRAMS[t];

        isFirstNote = true;
        for (let m = 0; m < totalChunks; m++) {
            const chordIdx = Math.floor(m / 2) % 4;
            const chordsForChord = CHORDS[chordIdx];

            for (let si = 0; si < numSlots; si++) {
                const idx = m * 8 + slots[si].s;
                if (idx >= total) break;

                if (chunkPos + 18 >= CHUNK_SIZE) {
                    chunks.push(chunk.subarray(0, chunkPos));
                    chunk = new Uint8Array(CHUNK_SIZE);
                    chunkPos = 0;
                }

                const b = blob[idx];
                const part = slots[si].part;
                const scale = chordsForChord[part];

                const pitch = scale[(b >> 4) & 0x0f];
                const durIdx = (b >> 2) & 0x03;
                const duration = DURATIONS[part][durIdx];
                const velocity = VELOCITIES[b & 0x03];
                const restDelay = isFirstNote ? (t * 120) : REST_DELAYS[part][durIdx];
                isFirstNote = false;

                if (restDelay < 128) {
                    chunk[chunkPos++] = restDelay;
                } else {
                    chunk[chunkPos++] = (restDelay >> 7) | 0x80;
                    chunk[chunkPos++] = restDelay & 0x7f;
                }

                chunk[chunkPos++] = 0x90 | t;
                chunk[chunkPos++] = pitch;
                chunk[chunkPos++] = velocity;

                if (duration < 128) {
                    chunk[chunkPos++] = duration;
                } else {
                    chunk[chunkPos++] = (duration >> 7) | 0x80;
                    chunk[chunkPos++] = duration & 0x7f;
                }

                chunk[chunkPos++] = 0x80 | t;
                chunk[chunkPos++] = pitch;
                chunk[chunkPos++] = 0x00;
            }

            if (onProgress && Date.now() - lastProgressTime > 40) {
                const fraction = (t + (m / totalChunks)) / 4;
                const pct = Math.min(99, Math.round(fraction * 100));
                onProgress(pct);
                lastProgressTime = Date.now();
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (chunkPos + 4 >= CHUNK_SIZE) {
            chunks.push(chunk.subarray(0, chunkPos));
            chunk = new Uint8Array(CHUNK_SIZE);
            chunkPos = 0;
        }

        chunk[chunkPos++] = 0x00;
        chunk[chunkPos++] = 0xff;
        chunk[chunkPos++] = 0x2f;
        chunk[chunkPos++] = 0x00;

        if (chunkPos > 0) {
            chunks.push(chunk.subarray(0, chunkPos));
        }
    }

    if (onProgress) onProgress(100);
    return new Blob(chunks, { type: "audio/midi" });
}

async function decodeFromMidi(midiBytes, onProgress) {
    const magic = String.fromCharCode(...midiBytes.slice(0, 4));
    if (magic !== "MThd") throw new Error("Not a valid MIDI file!");

    const numTracks = (midiBytes[10] << 8) | midiBytes[11];
    if (numTracks > 1) {
        return decodePolyphonicFromMidi(midiBytes, onProgress);
    }
    return decodeLegacyFromMidi(midiBytes, onProgress);
}

async function decodeLegacyFromMidi(midiBytes, onProgress) {
    let offset = 14;
    const trkMagic = String.fromCharCode(...midiBytes.slice(offset, offset + 4));
    if (trkMagic !== "MTrk") throw new Error("Missing MTrk chunk!");

    const view = new DataView(midiBytes.buffer, midiBytes.byteOffset, midiBytes.byteLength);
    const trackLen = view.getUint32(offset + 4, false);
    offset += 8;
    const trackStart = offset;
    const trackEnd = offset + trackLen;

    const CHUNK_SIZE = 2 * 1024 * 1024;
    const decChunks = [];
    let chunk = new Uint8Array(CHUNK_SIZE);
    let chunkPos = 0;

    let activeNote = null;
    let lastProgressTime = Date.now();

    while (offset < trackEnd) {
        const vlq = readVLQ(midiBytes, offset);
        const delta = vlq.value;
        offset = vlq.offset;

        const status = midiBytes[offset++];

        if (status === 0xff) {
            const metaType = midiBytes[offset++];
            const metaLen = readVLQ(midiBytes, offset);
            offset = metaLen.offset + metaLen.value;
            if (metaType === 0x2f) break;
        } else if ((status & 0xf0) === 0x90) {
            const pitch = midiBytes[offset++];
            const velocity = midiBytes[offset++];
            if (velocity > 0) {
                activeNote = { pitch, velocity };
            } else if (activeNote) {
                if (chunkPos >= CHUNK_SIZE) {
                    decChunks.push(chunk);
                    chunk = new Uint8Array(CHUNK_SIZE);
                    chunkPos = 0;
                }
                chunk[chunkPos++] = noteToByteLegacy(activeNote.pitch, delta, activeNote.velocity);
                activeNote = null;
            }
        } else if ((status & 0xf0) === 0x80) {
            const pitch = midiBytes[offset++];
            offset++;
            if (activeNote && activeNote.pitch === pitch) {
                if (chunkPos >= CHUNK_SIZE) {
                    decChunks.push(chunk);
                    chunk = new Uint8Array(CHUNK_SIZE);
                    chunkPos = 0;
                }
                chunk[chunkPos++] = noteToByteLegacy(activeNote.pitch, delta, activeNote.velocity);
                activeNote = null;
            }
        }

        if (onProgress && Date.now() - lastProgressTime > 50) {
            const pct = Math.round(((offset - trackStart) / trackLen) * 100);
            onProgress(pct);
            lastProgressTime = Date.now();
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (chunkPos > 0) {
        decChunks.push(chunk.subarray(0, chunkPos));
    }

    if (onProgress) onProgress(100);
    return new Blob(decChunks);
}

function noteToByteLegacy(pitch, duration, velocity) {
    const pitchIdx = SCALE.indexOf(pitch);
    const durIdx = DURATIONS_LEGACY.indexOf(duration);
    const velIdx = VELOCITIES_LEGACY.indexOf(velocity);
    if (pitchIdx === -1 || durIdx === -1 || velIdx === -1) {
        throw new Error(`Unexpected note values: pitch=${pitch}, dur=${duration}, vel=${velocity}`);
    }
    return (pitchIdx << 4) | (durIdx << 2) | velIdx;
}

async function decodePolyphonicFromMidi(midiBytes, onProgress) {
    let offset = 0;
    const numTracks = (midiBytes[10] << 8) | midiBytes[11];
    offset = 14;

    const decodedTrackChunks = [[], [], [], []];
    const view = new DataView(midiBytes.buffer, midiBytes.byteOffset, midiBytes.byteLength);
    let lastProgressTime = Date.now();
    const CHUNK_SIZE = 2 * 1024 * 1024;

    for (let t = 0; t < Math.min(numTracks, 4); t++) {
        if (offset >= midiBytes.length) break;
        const trkMagic = String.fromCharCode(...midiBytes.slice(offset, offset + 4));
        if (trkMagic !== "MTrk") throw new Error("Missing MTrk chunk at track " + t);
        const trkLen = view.getUint32(offset + 4, false);
        offset += 8;
        const trkEnd = offset + trkLen;

        const parts = TRACK_SLOT_PARTS[t];
        const numSlots = parts.length;
        let noteCount = 0;
        let activePitch = -1;
        let activeVel = 0;

        let curChunk = new Uint8Array(CHUNK_SIZE);
        let curChunkPos = 0;

        while (offset < trkEnd && offset < midiBytes.length) {
            let vlqVal = 0;
            let b;
            do {
                if (offset >= midiBytes.length) break;
                b = midiBytes[offset++];
                vlqVal = (vlqVal << 7) | (b & 0x7f);
            } while (b & 0x80);

            if (offset >= midiBytes.length) break;
            const delta = vlqVal;
            const status = midiBytes[offset++];

            if (status === 0xff) {
                const metaType = midiBytes[offset++];
                let metaLen = 0;
                do {
                    if (offset >= midiBytes.length) break;
                    b = midiBytes[offset++];
                    metaLen = (metaLen << 7) | (b & 0x7f);
                } while (b & 0x80);
                offset += metaLen;
                if (metaType === 0x2f) break;
            } else if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) {
                offset++;
            } else if ((status & 0xf0) === 0xa0 || (status & 0xf0) === 0xb0 || (status & 0xf0) === 0xe0) {
                offset += 2;
            } else if ((status & 0xf0) === 0x90) {
                const pitch = midiBytes[offset++];
                const velocity = midiBytes[offset++];
                if (velocity > 0) {
                    activePitch = pitch;
                    activeVel = velocity;
                } else if (activePitch !== -1) {
                    const chunkIdx = Math.floor(noteCount / numSlots);
                    const slotInTrack = noteCount % numSlots;
                    const part = parts[slotInTrack];
                    const chordIdx = Math.floor(chunkIdx / 2) % 4;
                    const scale = CHORDS[chordIdx][part];

                    const pitchIdx = scale.indexOf(activePitch);
                    const durIdx = DURATIONS[part].indexOf(delta);
                    const velIdx = VELOCITIES.indexOf(activeVel);

                    if (pitchIdx !== -1 && durIdx !== -1 && velIdx !== -1) {
                        if (curChunkPos >= CHUNK_SIZE) {
                            decodedTrackChunks[t].push(curChunk.subarray(0, curChunkPos));
                            curChunk = new Uint8Array(CHUNK_SIZE);
                            curChunkPos = 0;
                        }
                        curChunk[curChunkPos++] = (pitchIdx << 4) | (durIdx << 2) | velIdx;
                    }
                    noteCount++;
                    activePitch = -1;
                }
            } else if ((status & 0xf0) === 0x80) {
                const pitch = midiBytes[offset++];
                offset++;
                if (activePitch !== -1 && activePitch === pitch) {
                    const chunkIdx = Math.floor(noteCount / numSlots);
                    const slotInTrack = noteCount % numSlots;
                    const part = parts[slotInTrack];
                    const chordIdx = Math.floor(chunkIdx / 2) % 4;
                    const scale = CHORDS[chordIdx][part];

                    const pitchIdx = scale.indexOf(activePitch);
                    const durIdx = DURATIONS[part].indexOf(delta);
                    const velIdx = VELOCITIES.indexOf(activeVel);

                    if (pitchIdx !== -1 && durIdx !== -1 && velIdx !== -1) {
                        if (curChunkPos >= CHUNK_SIZE) {
                            decodedTrackChunks[t].push(curChunk.subarray(0, curChunkPos));
                            curChunk = new Uint8Array(CHUNK_SIZE);
                            curChunkPos = 0;
                        }
                        curChunk[curChunkPos++] = (pitchIdx << 4) | (durIdx << 2) | velIdx;
                    }
                    noteCount++;
                    activePitch = -1;
                }
            }

            if (onProgress && Date.now() - lastProgressTime > 40) {
                const trkFraction = (t + ((offset - (trkEnd - trkLen)) / trkLen)) / numTracks;
                const pct = Math.min(90, Math.round(trkFraction * 90));
                onProgress(pct);
                lastProgressTime = Date.now();
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (curChunkPos > 0) {
            decodedTrackChunks[t].push(curChunk.subarray(0, curChunkPos));
        }
        offset = trkEnd;
    }

    const trackBuffers = decodedTrackChunks.map(chunks => {
        let len = 0;
        for (let c of chunks) len += c.length;
        const merged = new Uint8Array(len);
        let pos = 0;
        for (let c of chunks) {
            merged.set(c, pos);
            pos += c.length;
        }
        return merged;
    });

    const decChunks = [];
    let outChunk = new Uint8Array(CHUNK_SIZE);
    let outPos = 0;
    const trackPtrs = [0, 0, 0, 0];

    while (true) {
        let any = false;
        for (let t = 0; t < 4; t++) {
            const numSlots = TRACK_SLOT_PARTS[t].length;
            const buf = trackBuffers[t];
            for (let s = 0; s < numSlots; s++) {
                if (trackPtrs[t] < buf.length) {
                    any = true;
                    if (outPos >= CHUNK_SIZE) {
                        decChunks.push(outChunk.subarray(0, outPos));
                        outChunk = new Uint8Array(CHUNK_SIZE);
                        outPos = 0;
                    }
                    outChunk[outPos++] = buf[trackPtrs[t]++];
                }
            }
        }
        if (!any) break;
    }

    if (outPos > 0) {
        decChunks.push(outChunk.subarray(0, outPos));
    }

    if (onProgress) onProgress(100);
    return new Blob(decChunks);
}

async function sha256Hex(bytes) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

async function gzipCompress(bytes) {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const arrayBuffer = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

async function gzipDecompress(bytes) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const arrayBuffer = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

function formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    if (s < 3600) {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${r < 10 ? "0" : ""}${r}`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h < 24) {
        return `${h}:${m < 10 ? "0" : ""}${m}:${r < 10 ? "0" : ""}${r}`;
    }
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return `${d}d ${remH}h ${m}m`;
}

function formatNotes(count) {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(2) + "M notes";
    }
    if (count >= 1000) {
        return (count / 1000).toFixed(1) + "K notes";
    }
    return count.toLocaleString() + " notes";
}

let currentMidiBlob = null;
let currentMidiFilename = "";

let currentDecodedBlob = null;
let currentDecodedFilename = "";

function switchToPlayerTab() {
    const playerTabBtn = document.querySelector('[data-tab="playerTab"]');
    if (playerTabBtn) playerTabBtn.click();
}

function setProgress(boxId, barId, textId, pct, text) {
    const box = document.getElementById(boxId);
    const bar = document.getElementById(barId);
    const txt = document.getElementById(textId);
    if (box) box.style.display = "block";
    if (bar) bar.style.width = pct + "%";
    if (txt) txt.textContent = text || (pct + "%");
}

function hideProgress(boxId) {
    const box = document.getElementById(boxId);
    if (box) {
        setTimeout(() => {
            box.style.display = "none";
        }, 600);
    }
}

async function handleEncodeFile(file, isPolyphonic = true) {
    const errorEl = document.getElementById("encodeError");
    const metaEl = document.getElementById("encodeMeta");
    const downloadBtn = document.getElementById("downloadMidiBtn");
    const playBtn = document.getElementById("playMidiBtn");
    const gzipToggle = document.getElementById("gzipToggle");

    if (errorEl) errorEl.textContent = "";
    if (metaEl) metaEl.innerHTML = "";
    if (downloadBtn) downloadBtn.disabled = true;
    if (playBtn) playBtn.disabled = true;

    if (window.midiPlayer) {
        window.midiPlayer.stop();
    }

    try {
        setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", 10, "Reading file... 10%");
        await new Promise(r => setTimeout(r, 0));
        const fileBuffer = await file.arrayBuffer();
        const fileBytes = new Uint8Array(fileBuffer);

        setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", 25, "Calculating SHA-256... 25%");
        await new Promise(r => setTimeout(r, 0));
        const originalHash = await sha256Hex(fileBytes);

        let dataToPack = fileBytes;
        let isCompressed = false;
        if (gzipToggle && gzipToggle.checked) {
            setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", 40, "Compressing with Gzip... 40%");
            await new Promise(r => setTimeout(r, 0));
            dataToPack = await gzipCompress(fileBytes);
            isCompressed = true;
        }

        const packed = packFile(file.name, dataToPack);

        const modeStr = isPolyphonic ? "polyphonic" : "legacy";
        const progressLabel = "Encoding MIDI...";
        setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", 50, `${progressLabel} 50%`);
        await new Promise(r => setTimeout(r, 0));

        const midiBlob = await encodeToMidi(packed, (pct) => {
            const mapped = 50 + Math.round(pct * 0.48);
            setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", mapped, `${progressLabel} ${mapped}%`);
        }, modeStr);

        currentMidiBlob = midiBlob;
        currentMidiFilename = file.name.replace(/\.[^/.]+$/, "") + ".mid";

        setProgress("encodeProgressBox", "encodeProgressBar", "encodeProgressText", 100, "Done! 100%");
        hideProgress("encodeProgressBox");

        if (downloadBtn) downloadBtn.disabled = false;
        if (playBtn) playBtn.disabled = false;

        const estDurationSec = isPolyphonic ? (packed.length / 8) * 2.4 : packed.length * 0.45;

        if (metaEl) {
            metaEl.innerHTML = `
                <div><strong>File:</strong> ${file.name} (${fileBytes.length.toLocaleString()} bytes${isCompressed ? ` → compressed to ${dataToPack.length.toLocaleString()} bytes` : ""})</div>
                <div><strong>Format:</strong> ${isPolyphonic ? "Harmonic Multi-Layer (Lossless Polyphonic)" : "Monophonic Pentatonic"}</div>
                <div><strong>MIDI Size:</strong> ${midiBlob.size.toLocaleString()} bytes (${formatNotes(packed.length)})</div>
                <div><strong>Estimated Duration:</strong> ~${formatTime(estDurationSec)}</div>
                <div class="hash">SHA-256: ${originalHash}</div>
            `;
        }

        if (window.midiPlayer) {
            const previewSlice = await midiBlob.slice(0, 2000000).arrayBuffer();
            window.midiPlayer.loadMidi(new Uint8Array(previewSlice), packed.length);
            const trackInfo = document.getElementById("playerTrackInfo");
            if (trackInfo) {
                trackInfo.textContent = `${currentMidiFilename} (${formatNotes(packed.length)})`;
            }
        }
    } catch (err) {
        hideProgress("encodeProgressBox");
        if (errorEl) errorEl.textContent = err.message || "Failed to encode file";
    }
}

async function handleDecodeFile(file) {
    const errorEl = document.getElementById("decodeError");
    const metaEl = document.getElementById("decodeMeta");
    const downloadBtn = document.getElementById("downloadFileBtn");

    if (errorEl) errorEl.textContent = "";
    if (metaEl) metaEl.innerHTML = "";
    if (downloadBtn) downloadBtn.disabled = true;

    try {
        setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", 15, "Reading MIDI file... 15%");
        const buffer = await file.arrayBuffer();
        const midiBytes = new Uint8Array(buffer);

        setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", 30, "Decoding MIDI layers... 30%");
        let decodedBlob = await decodeFromMidi(midiBytes, (pct) => {
            const mapped = 30 + Math.round(pct * 0.4);
            setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", mapped, `Decoding layers... ${mapped}%`);
        });

        setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", 75, "Unpacking container... 75%");

        const headerCheck = new Uint8Array(await decodedBlob.slice(0, 2).arrayBuffer());
        if (headerCheck.length >= 2 && headerCheck[0] === 0x1f && headerCheck[1] === 0x8b) {
            try {
                const decompressedStream = decodedBlob.stream().pipeThrough(new DecompressionStream("gzip"));
                decodedBlob = await new Response(decompressedStream).blob();
            } catch (e) {}
        }

        const headBuf = new Uint8Array(await decodedBlob.slice(0, 265).arrayBuffer());
        const headerInfo = unpackFileHeader(headBuf);

        let dataBlob = decodedBlob.slice(headerInfo.offset, headerInfo.offset + headerInfo.dataLen);
        let wasDecompressed = false;

        const dataCheck = new Uint8Array(await dataBlob.slice(0, 2).arrayBuffer());
        if (dataCheck.length >= 2 && dataCheck[0] === 0x1f && dataCheck[1] === 0x8b) {
            try {
                const decompressedStream = dataBlob.stream().pipeThrough(new DecompressionStream("gzip"));
                dataBlob = await new Response(decompressedStream).blob();
                wasDecompressed = true;
            } catch (e) {}
        }

        setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", 90, "Verifying SHA-256... 90%");
        const finalBuffer = await dataBlob.arrayBuffer();
        const recoveredHash = await sha256Hex(new Uint8Array(finalBuffer));

        currentDecodedBlob = dataBlob;
        currentDecodedFilename = headerInfo.name;

        setProgress("decodeProgressBox", "decodeProgressBar", "decodeProgressText", 100, "Done! 100%");
        hideProgress("decodeProgressBox");

        if (downloadBtn) downloadBtn.disabled = false;

        if (metaEl) {
            metaEl.innerHTML = `
                <div><strong>Recovered:</strong> ${headerInfo.name} (${dataBlob.size.toLocaleString()} bytes${wasDecompressed ? " decompressed" : ""})</div>
                <div class="hash">SHA-256: ${recoveredHash}</div>
            `;
        }

        if (window.midiPlayer) {
            const previewSlice = await file.slice(0, 2000000).arrayBuffer();
            window.midiPlayer.loadMidi(new Uint8Array(previewSlice), Math.round(file.size / 8.5));
            const trackInfo = document.getElementById("playerTrackInfo");
            if (trackInfo) {
                trackInfo.textContent = `${file.name} (${formatNotes(Math.round(file.size / 8.5))})`;
            }
        }
    } catch (err) {
        hideProgress("decodeProgressBox");
        if (errorEl) errorEl.textContent = err.message || "Failed to decode MIDI file";
    }
}

function handleDirectMidiUpload(file) {
    file.slice(0, 2000000).arrayBuffer().then(buf => {
        const bytes = new Uint8Array(buf);
        if (window.midiPlayer) {
            const estCount = Math.round(file.size / 8.5);
            window.midiPlayer.loadMidi(bytes, estCount);
            window.midiPlayer.play();
            const trackInfo = document.getElementById("playerTrackInfo");
            if (trackInfo) {
                trackInfo.textContent = `${file.name} (${formatNotes(estCount)})`;
            }
        }
    }).catch(err => {
        const trackInfo = document.getElementById("playerTrackInfo");
        if (trackInfo) {
            trackInfo.textContent = "Error loading MIDI: " + (err.message || "Invalid file");
        }
    });
}

function initApp() {
    const tabBtns = document.querySelectorAll(".tab-btn");
    const tabPanes = document.querySelectorAll(".tab-pane");

    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetId = btn.getAttribute("data-tab");
            tabBtns.forEach(b => b.classList.remove("active"));
            tabPanes.forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            const targetPane = document.getElementById(targetId);
            if (targetPane) targetPane.classList.add("active");
        });
    });

    const encodeDrop = document.getElementById("encodeDrop");
    const encodeInput = document.getElementById("encodeInput");
    const downloadMidiBtn = document.getElementById("downloadMidiBtn");
    const playMidiBtn = document.getElementById("playMidiBtn");
    const polyphonyToggle = document.getElementById("polyphonyToggle");

    if (encodeDrop && encodeInput) {
        encodeDrop.addEventListener("click", () => encodeInput.click());
        encodeInput.addEventListener("click", (e) => e.stopPropagation());
        encodeInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files[0]) {
                const isPoly = polyphonyToggle ? polyphonyToggle.checked : true;
                handleEncodeFile(e.target.files[0], isPoly);
            }
        });

        encodeDrop.addEventListener("dragover", (e) => {
            e.preventDefault();
            encodeDrop.classList.add("dragover");
        });
        encodeDrop.addEventListener("dragleave", () => {
            encodeDrop.classList.remove("dragover");
        });
        encodeDrop.addEventListener("drop", (e) => {
            e.preventDefault();
            encodeDrop.classList.remove("dragover");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                const isPoly = polyphonyToggle ? polyphonyToggle.checked : true;
                handleEncodeFile(e.dataTransfer.files[0], isPoly);
            }
        });
    }

    if (downloadMidiBtn) {
        downloadMidiBtn.addEventListener("click", () => {
            if (!currentMidiBlob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(currentMidiBlob);
            a.download = currentMidiFilename || "music.mid";
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }

    if (playMidiBtn) {
        playMidiBtn.addEventListener("click", () => {
            if (!window.midiPlayer) return;
            switchToPlayerTab();
            if (window.midiPlayer.isPlaying) {
                window.midiPlayer.pause();
            } else {
                window.midiPlayer.play();
            }
        });
    }

    const decodeDrop = document.getElementById("decodeDrop");
    const decodeInput = document.getElementById("decodeInput");
    const downloadFileBtn = document.getElementById("downloadFileBtn");

    if (decodeDrop && decodeInput) {
        decodeDrop.addEventListener("click", () => decodeInput.click());
        decodeInput.addEventListener("click", (e) => e.stopPropagation());
        decodeInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files[0]) {
                handleDecodeFile(e.target.files[0]);
            }
        });

        decodeDrop.addEventListener("dragover", (e) => {
            e.preventDefault();
            decodeDrop.classList.add("dragover");
        });
        decodeDrop.addEventListener("dragleave", () => {
            decodeDrop.classList.remove("dragover");
        });
        decodeDrop.addEventListener("drop", (e) => {
            e.preventDefault();
            decodeDrop.classList.remove("dragover");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleDecodeFile(e.dataTransfer.files[0]);
            }
        });
    }

    if (downloadFileBtn) {
        downloadFileBtn.addEventListener("click", () => {
            if (!currentDecodedBlob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(currentDecodedBlob);
            a.download = currentDecodedFilename || "recovered_file";
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }

    const playerDrop = document.getElementById("playerDrop");
    const playerInput = document.getElementById("playerInput");

    if (playerDrop && playerInput) {
        playerDrop.addEventListener("click", () => playerInput.click());
        playerInput.addEventListener("click", (e) => e.stopPropagation());
        playerInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files[0]) {
                handleDirectMidiUpload(e.target.files[0]);
            }
        });

        playerDrop.addEventListener("dragover", (e) => {
            e.preventDefault();
            playerDrop.classList.add("dragover");
        });
        playerDrop.addEventListener("dragleave", () => {
            playerDrop.classList.remove("dragover");
        });
        playerDrop.addEventListener("drop", (e) => {
            e.preventDefault();
            playerDrop.classList.remove("dragover");
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleDirectMidiUpload(e.dataTransfer.files[0]);
            }
        });
    }

    const canvas = document.getElementById("visualizerCanvas");
    const playerPlayBtn = document.getElementById("playerPlayBtn");
    const playerStopBtn = document.getElementById("playerStopBtn");
    const playerScrubber = document.getElementById("playerScrubber");
    const playerTimeCurrent = document.getElementById("playerTimeCurrent");
    const playerTimeTotal = document.getElementById("playerTimeTotal");
    const playerVolume = document.getElementById("playerVolume");

    if (window.midiPlayer && canvas) {
        window.midiPlayer.initCanvas(canvas);

        window.midiPlayer.onProgress = (current, total) => {
            if (playerTimeCurrent) playerTimeCurrent.textContent = formatTime(current);
            if (playerTimeTotal) playerTimeTotal.textContent = formatTime(total);
            if (playerScrubber && total > 0) {
                playerScrubber.value = ((current / total) * 100).toFixed(1);
            }
        };

        window.midiPlayer.onStateChange = (state, player) => {
            const isPl = state === "playing";
            const playText = isPl ? "⏸ Pause" : "▶ Play";
            const simplePlayText = isPl ? "Pause" : "Play";

            if (playerPlayBtn) playerPlayBtn.textContent = playText;
            if (playMidiBtn) playMidiBtn.textContent = simplePlayText;

            if (state === "stopped") {
                if (playerScrubber) playerScrubber.value = 0;
                if (playerTimeCurrent) playerTimeCurrent.textContent = "0:00";
            }
            if (state === "loaded") {
                if (playerTimeTotal) playerTimeTotal.textContent = formatTime(player.totalDuration);
            }
        };

        if (playerPlayBtn) {
            playerPlayBtn.addEventListener("click", () => {
                if (window.midiPlayer.isPlaying) {
                    window.midiPlayer.pause();
                } else {
                    window.midiPlayer.play();
                }
            });
        }

        if (playerStopBtn) {
            playerStopBtn.addEventListener("click", () => {
                window.midiPlayer.stop();
            });
        }

        if (playerScrubber) {
            playerScrubber.addEventListener("input", (e) => {
                const pct = parseFloat(e.target.value) / 100;
                const sec = pct * window.midiPlayer.totalDuration;
                window.midiPlayer.seek(sec);
            });
        }

        if (playerVolume) {
            playerVolume.addEventListener("input", (e) => {
                window.midiPlayer.setVolume(parseFloat(e.target.value));
            });
        }
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}
