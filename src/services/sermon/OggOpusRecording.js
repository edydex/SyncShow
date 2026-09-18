// Keep the framing contract aligned with Heritage Community OggOpusRecording.ts.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateOggOpusRecording = validateOggOpusRecording;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value << 24;
    for (let bit = 0; bit < 8; bit++) {
        crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    return crc >>> 0;
});
function pageCrc(page) {
    let crc = 0;
    for (let index = 0; index < page.length; index++) {
        const value = index >= 22 && index < 26 ? 0 : page[index];
        crc = (crc << 8) ^ crcTable[((crc >>> 24) ^ value) & 255];
    }
    return crc >>> 0;
}
function validComments(packet) {
    if (packet.length < 16 || packet.toString('ascii', 0, 8) !== 'OpusTags')
        return false;
    let offset = 12 + packet.readUInt32LE(8);
    if (offset + 4 > packet.length)
        return false;
    const count = packet.readUInt32LE(offset);
    offset += 4;
    for (let index = 0; index < count; index++) {
        if (offset + 4 > packet.length)
            return false;
        offset += 4 + packet.readUInt32LE(offset);
        if (offset > packet.length)
            return false;
    }
    return true;
}
async function validateOggOpusRecording(read, size) {
    if (!Number.isSafeInteger(size) || size < 47)
        return false;
    let offset = 0, serial = -1, sequence = 0, packetCount = 0, packetBytes = 0;
    let continued = false, ended = false, preSkip = 0;
    let headerParts = [];
    // Bounded work even for malformed files made almost entirely of tiny pages.
    while (offset < size && sequence < 1_000_000) {
        if (ended)
            return false;
        const header = await read(offset, 27);
        if (!header || header.toString('ascii', 0, 4) !== 'OggS' || header[4] !== 0)
            return false;
        const flags = header[5];
        if (flags & ~7 || Boolean(flags & 1) !== continued || Boolean(flags & 2) !== (sequence === 0))
            return false;
        if (sequence === 0)
            serial = header.readUInt32LE(14);
        if (header.readUInt32LE(14) !== serial || header.readUInt32LE(18) !== sequence)
            return false;
        const laces = await read(offset + 27, header[26]);
        if (!laces || !laces.length)
            return false;
        const payloadSize = laces.reduce((sum, length) => sum + length, 0);
        const pageSize = 27 + laces.length + payloadSize;
        if (offset + pageSize > size)
            return false;
        const page = await read(offset, pageSize);
        if (!page || pageCrc(page) !== header.readUInt32LE(22))
            return false;
        let position = 27 + laces.length;
        for (let index = 0; index < laces.length; index++) {
            const length = laces[index];
            packetBytes += length;
            if (packetCount < 2) {
                if (packetBytes > 1024 * 1024)
                    return false;
                headerParts.push(page.subarray(position, position + length));
            }
            position += length;
            continued = length === 255;
            if (continued)
                continue;
            if (packetCount === 0) {
                const packet = Buffer.concat(headerParts);
                if (sequence !== 0 || index !== laces.length - 1 || packet.length < 19
                    || packet.toString('ascii', 0, 8) !== 'OpusHead'
                    || packet[8] < 1 || packet[8] > 15 || ![1, 2].includes(packet[9])
                    || packet[18] !== 0 || (packet[8] === 1 && packet.length !== 19))
                    return false;
                preSkip = packet.readUInt16LE(10);
            }
            else if (packetCount === 1) {
                if (index !== laces.length - 1 || !validComments(Buffer.concat(headerParts)))
                    return false;
            }
            else if (packetBytes === 0)
                return false;
            packetCount++;
            packetBytes = 0;
            headerParts = [];
        }
        if (sequence === 0 && packetCount !== 1)
            return false;
        ended = Boolean(flags & 4);
        if (ended && (continued || header.readBigInt64LE(6) <= BigInt(preSkip)))
            return false;
        offset += pageSize;
        sequence++;
    }
    return offset === size && ended && !continued && packetCount >= 3;
}
