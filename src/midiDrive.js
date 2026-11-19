const MAGIC = new TextEncoder().encode("MIDI");

const SCALE = [
    48, 50, 52, 55, 57, // C3, D3, E3, G3, A3
    60, 62, 64, 67, 69, // C4, D4, E4, G4, A4
    72, 74, 76, 79, 81, // C5, D5, E5, G5, A5
    84                  // C6
];

const DURATIONS = [120, 240, 480, 960]; // 16th, 8th, quarter, half

const VELOCITIES = [45, 70, 95, 120];


function packFile(filename, fileBytes) {
    const nameBytes = new TextEncoder().encode(filename);
    if (nameBytes.length > 255) throw new Error("Filename too long (max 255 bytes)");

    const out = new Uint8Array(9 + nameBytes.length + fileBytes.length);
    const view = new DataView(out.buffer);

    out.set(MAGIC, 0);
    view.setUint8(4, nameBytes.length);
    view.setUint32(5, fileBytes.length, false); // big-endian
    out.set(nameBytes, 9);
    out.set(fileBytes, 9 + nameBytes.length);

    return out;
}

function unpackFile(blob) {
    for (let i = 0; i < 4; i++) {
        if (blob[i] !== MAGIC[i]) throw new Error("Not a valid MIDI-Drive file!");
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const nameLen = view.getUint8(4);
    const dataLen = view.getUint32(5, false);

    const name = new TextDecoder().decode(blob.slice(9, 9 + nameLen));
    const data = blob.slice(9 + nameLen, 9 + nameLen + dataLen);
    if (data.length !== dataLen) throw new Error("File was cut off!");

    return { name, data };
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


function encodeToMidi(blob) {
    const track = [];

    track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);

    for (const byte of blob) {
        const pitchIdx = (byte >> 4) & 0x0f; // top 4 bits (0..15)
        const durIdx = (byte >> 2) & 0x03; // next 2 bits (0..3)
        const velIdx = byte & 0x03;        // last 2 bits (0..3)

        const pitch = SCALE[pitchIdx];
        const duration = DURATIONS[durIdx];
        const velocity = VELOCITIES[velIdx];

        track.push(0x00, 0x90, pitch, velocity);
        track.push(...writeVLQ(duration), 0x80, pitch, 0x00);
    }

    track.push(0x00, 0xff, 0x2f, 0x00);

    const header = [
        0x4d, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // header length = 6
        0x00, 0x00,             // format 0 (single track)
        0x00, 0x01,             // 1 track
        0x01, 0xe0              // 480 ticks per quarter note
    ];

    const len = track.length;
    const trackHeader = [
        0x4d, 0x54, 0x72, 0x6b, // "MTrk"
        (len >>> 24) & 0xff,
        (len >>> 16) & 0xff,
        (len >>> 8) & 0xff,
        len & 0xff
    ];

    return new Uint8Array([...header, ...trackHeader, ...track]);
}


function decodeFromMidi(midiBytes) {
    const magic = String.fromCharCode(...midiBytes.slice(0, 4));
    if (magic !== "MThd") throw new Error("Not a valid MIDI file!");

    let offset = 14;
    const trkMagic = String.fromCharCode(...midiBytes.slice(offset, offset + 4));
    if (trkMagic !== "MTrk") throw new Error("Missing MTrk chunk!");

    const view = new DataView(midiBytes.buffer, midiBytes.byteOffset, midiBytes.byteLength);
    const trackLen = view.getUint32(offset + 4, false);
    offset += 8;
    const trackEnd = offset + trackLen;

    const decodedBytes = [];
    let activeNote = null;

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
                decodedBytes.push(noteToByte(activeNote.pitch, delta, activeNote.velocity));
                activeNote = null;
            }
        } else if ((status & 0xf0) === 0x80) {

            const pitch = midiBytes[offset++];
            offset++;
            if (activeNote && activeNote.pitch === pitch) {
                decodedBytes.push(noteToByte(activeNote.pitch, delta, activeNote.velocity));
                activeNote = null;
            }
        }
    }

    return new Uint8Array(decodedBytes);
}

function noteToByte(pitch, duration, velocity) {
    const pitchIdx = SCALE.indexOf(pitch);
    const durIdx = DURATIONS.indexOf(duration);
    const velIdx = VELOCITIES.indexOf(velocity);
    if (pitchIdx === -1 || durIdx === -1 || velIdx === -1) {
        throw new Error(`Unexpected note values: pitch=${pitch}, dur=${duration}, vel=${velocity}`);
    }
    return (pitchIdx << 4) | (durIdx << 2) | velIdx;
}

//sha-256 helper

async function sha256Hex(bytes) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}