/**
 * ax25decode.js — Comprehensive AX.25 frame decoder for the SoundModem extension.
 *
 * Ported from LinBPQ/BPQ32 Moncode.c (G8BPQ, GPL) with additions from the
 * AX.25 v2.2 specification and NET/ROM protocol documentation.
 *
 * Exported global: AX25Decode
 *   AX25Decode.parse(bytes: Uint8Array) → ParsedFrame | null
 *
 * ParsedFrame {
 *   from:          string       — source callsign e.g. "GB7RDG-2"
 *   to:            string       — destination callsign
 *   digipeaters:   string[]     — digi callsigns (with * if actioned)
 *   ctrl:          number       — raw control byte
 *   frameClass:    'I'|'S'|'U' — I/S/U frame class
 *   frameType:     string       — 'ui','i','rr','rnr','rej','srej','sabm','sabme',
 *                                 'ua','disc','dm','frmr','xid','test',
 *                                 'aprs','netrom','nodes','ip','arp'
 *   isCommand:     bool|null    — true=command, false=response, null=v1/unknown
 *   pollFinal:     bool         — P/F bit set
 *   ns:            number|null  — N(S) for I-frames
 *   nr:            number|null  — N(R) for I/S-frames
 *   pid:           number|null  — PID byte
 *   pidName:       string|null  — human-readable PID
 *   info:          string       — full decoded description line
 *   infoRaw:       string       — raw info field text (PID 0xF0 payload)
 *   isAPRS:        bool
 *   netrom:        object|null  — decoded NET/ROM (if PID=0xCF)
 *   ip:            object|null  — decoded IP (if PID=0xCC)
 *   arp:           object|null  — decoded ARP (if PID=0xCD)
 *   frmr:          object|null  — decoded FRMR payload
 * }
 */

/* exported AX25Decode */

// Use window assignment so the global is accessible across script tags
// regardless of strict-mode or browser script scoping quirks.
window.AX25Decode = (() => {

    // ── AX.25 / NET/ROM constants ─────────────────────────────────────────────

    const PID_NETROM    = 0xCF;
    const PID_IP        = 0xCC;
    const PID_ARP       = 0xCD;
    const PID_FRAG_IP   = 0x08;
    const PID_NO_L3     = 0xF0;
    const PID_COMP_L2_1 = 0xF1;
    const PID_COMP_L2_2 = 0xF2;

    // U-frame control values (P/F bit masked out)
    const CTRL_UI    = 0x03;
    const CTRL_SABM  = 0x2F;
    const CTRL_SABME = 0x6F;
    const CTRL_DISC  = 0x43;
    const CTRL_DM    = 0x0F;
    const CTRL_UA    = 0x63;
    const CTRL_FRMR  = 0x87;
    const CTRL_XID   = 0xAF;
    const CTRL_TEST  = 0xE3;

    // NET/ROM L4 opcodes
    const NR_CREQ  = 0x01;
    const NR_CACK  = 0x02;
    const NR_DREQ  = 0x03;
    const NR_DACK  = 0x04;
    const NR_INFO  = 0x05;
    const NR_IACK  = 0x06;
    const NR_RESET = 0x07;

    // NET/ROM L4 flags
    const NR_FLAG_CHOKE = 0x80;
    const NR_FLAG_NAK   = 0x40;
    const NR_FLAG_MORE  = 0x20;
    const NR_FLAG_COMP  = 0x10;

    const NODES_SIG = 0xFF;

    // ── Address helpers ───────────────────────────────────────────────────────

    /** Decode a 7-byte AX.25 address field. */
    function decodeAddr(bytes, offset) {
        let call = '';
        for (let i = 0; i < 6; i++) {
            const ch = bytes[offset + i] >> 1;
            if (ch !== 0x20 && ch !== 0x00) call += String.fromCharCode(ch);
        }
        call = call.trim();
        const ssidByte = bytes[offset + 6];
        const ssid     = (ssidByte >> 1) & 0x0F;
        const hBit     = (ssidByte & 0x80) !== 0;
        const isLast   = (ssidByte & 0x01) !== 0;
        const callStr  = ssid > 0 ? `${call}-${ssid}` : call;
        return { call: callStr, ssid, hBit, isLast };
    }

    function fmtCall(addr, showStar = false) {
        return addr.call + (showStar && addr.hBit ? '*' : '');
    }

    /** Decode a 7-byte AX.25 address into a plain callsign string. */
    function decodeAX25Call(bytes, offset) {
        if (offset + 7 > bytes.length) return '?';
        return decodeAddr(bytes, offset).call;
    }

    /** Decode a null/space-padded ASCII alias of fixed length. */
    function decodeAlias(bytes, offset, len) {
        let s = '';
        for (let i = 0; i < len; i++) {
            const c = bytes[offset + i];
            if (c === 0 || c === 0x20) break;
            s += String.fromCharCode(c);
        }
        return s.trim();
    }

    /** Decode a 4-byte big-endian IPv4 address. */
    function decodeIPv4(bytes, offset) {
        return `${bytes[offset]}.${bytes[offset+1]}.${bytes[offset+2]}.${bytes[offset+3]}`;
    }

    /**
     * Decode info field bytes to a printable string.
     * Strips control chars except CR/LF; tries UTF-8 then latin1.
     */
    function decodeInfoBytes(bytes, offset, len) {
        const slice = bytes.slice(offset, offset + len);
        try {
            const s = new TextDecoder('utf-8', { fatal: true }).decode(slice);
            return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        } catch (_) {
            let s = '';
            for (let i = 0; i < slice.length; i++) {
                const c = slice[i] & 0x7F;
                if (c === 0x0D || c === 0x0A || c >= 0x20) s += String.fromCharCode(c);
            }
            return s;
        }
    }

    // ── PID name lookup ───────────────────────────────────────────────────────

    function pidName(pid) {
        const names = {
            0x01: 'ISO 8208/X.25 PLP',
            0x06: 'Compressed TCP/IP',
            0x07: 'Uncompressed TCP/IP',
            0x08: 'Segmentation fragment',
            0xC3: 'TEXNET datagram',
            0xC4: 'Link Quality Protocol',
            0xCA: 'Appletalk',
            0xCB: 'Appletalk ARP',
            0xCC: 'IP',
            0xCD: 'ARP',
            0xCE: 'FlexNet',
            0xCF: 'NET/ROM',
            0xF0: 'No layer 3',
            0xF1: 'Compressed L2',
            0xF2: 'Compressed L2',
            0xFF: 'Escape',
        };
        return names[pid] || `0x${pid.toString(16).padStart(2,'0')}`;
    }

    // ── NET/ROM decoder ───────────────────────────────────────────────────────

    /**
     * Decode an INP3 Routing Information Frame (RIF).
     * Sent as a non-UI NODES frame (first byte=0xFF, frame type != UI).
     * Format: N × { 7-byte AX.25 call, hops:1, rtt:2 BE, optional TLVs, 0x00 terminator }
     * TLV opcode 0 = alias (right-justified in 6 bytes), opcode 1 = IP address.
     */
    function decodeINP3RIF(payload) {
        // payload starts after the 0xFF signature byte
        const entries = [];
        let pos = 0;
        let remaining = payload.length;

        while (remaining > 9) {
            if (pos + 7 > payload.length) break;
            const call = decodeAX25Call(payload, pos);
            pos += 7;
            remaining -= 7;

            if (remaining < 3) break;
            const hops = payload[pos++];
            const rtt  = (payload[pos] << 8) | payload[pos + 1];
            pos += 2;
            remaining -= 3;

            let alias = '';
            // Process optional TLV fields until 0x00 terminator
            while (remaining > 0 && payload[pos] !== 0) {
                const tlvLen    = payload[pos];
                const tlvOpcode = payload[pos + 1];
                if (tlvLen < 2 || tlvLen > remaining) break;
                if (tlvOpcode === 0 && tlvLen <= 8) {
                    // Alias: right-justified in 6 chars
                    alias = decodeAlias(payload, pos + 2, tlvLen - 2);
                }
                pos += tlvLen;
                remaining -= tlvLen;
            }
            // Skip 0x00 terminator
            if (remaining > 0 && payload[pos] === 0) { pos++; remaining--; }

            entries.push(`${alias || call}:${call} hops=${hops} rtt=${rtt}ms`);
        }

        return {
            type: 'nodes',
            summary: 'INP3 RIF',
            detail: entries.join(', '),
            entries,
        };
    }

    /**
     * Decode a NET/ROM NODES broadcast (UI frame, PID=0xCF, first byte=0xFF).
     * Standard NODES: alias(6) + N×21-byte entries {dest(7), alias(6), node(7), quality(1)}.
     * INP3 RIF: non-UI frame with same signature — handled by decodeINP3RIF.
     */
    function decodeNODES(payload, isUI = true) {
        if (!isUI) {
            // INP3 RIF — payload[0]=0xFF already consumed by caller
            return decodeINP3RIF(payload.slice(1));
        }
        if (payload.length < 7) {
            return { type: 'nodes', summary: 'NODES (truncated)', detail: '', entries: [] };
        }
        const alias = decodeAlias(payload, 1, 6);
        const entries = [];
        let pos = 7;
        while (pos + 21 <= payload.length) {
            const dest      = decodeAX25Call(payload, pos);     pos += 7;
            const entAlias  = decodeAlias(payload, pos, 6);     pos += 6;
            const node      = decodeAX25Call(payload, pos);     pos += 7;
            const quality   = payload[pos];                      pos += 1;
            entries.push(`${entAlias || dest}:${dest} via ${node} qlty=${quality}`);
        }
        return {
            type: 'nodes',
            summary: `NODES from ${alias}`,
            detail: entries.join(', '),
            entries,
        };
    }

    function decodeNetROM(payload, isUI = true) {
        if (payload.length < 1) {
            return { type: 'netrom', summary: 'NET/ROM (empty)', detail: '', raw: null };
        }

        if (payload[0] === NODES_SIG) return decodeNODES(payload, isUI);

        if (payload[0] === 0xFE) {
            const alias = decodeAlias(payload, 1, 6);
            return { type: 'nodes-poll', summary: `NET/ROM NODES POLL from ${alias}`, detail: '', raw: null };
        }

        if (payload.length < 20) {
            return { type: 'netrom', summary: 'NET/ROM (truncated)', detail: '', raw: null };
        }

        const dest   = decodeAX25Call(payload, 0);
        const origin = decodeAX25Call(payload, 7);
        const ttl    = payload[14];
        const cktIdx = payload[15];
        const cktId  = payload[16];
        const txSeq  = payload[17];
        const rxSeq  = payload[18];
        const opByte = payload[19];
        const opcode = opByte & 0x0F;
        const flags  = opByte & 0xF0;

        const cktStr  = `${cktIdx.toString(16).padStart(2,'0')}${cktId.toString(16).padStart(2,'0')}`;
        const flagParts = [];
        if (flags & NR_FLAG_CHOKE) flagParts.push('CHOKE');
        if (flags & NR_FLAG_NAK)   flagParts.push('NAK');
        if (flags & NR_FLAG_MORE)  flagParts.push('MORE');
        if (flags & NR_FLAG_COMP)  flagParts.push('COMP');
        const flagStr = flagParts.join(' ');

        const hdr = `${origin}→${dest} ttl=${ttl} ckt=${cktStr}`;

        switch (opcode) {
            case NR_CREQ: {
                if (payload.length < 35) {
                    return { type: 'l4-connect', summary: `NET/ROM CON REQ ${hdr}`, detail: '', raw: null };
                }
                const window  = payload[20];
                const myCall  = decodeAX25Call(payload, 21);
                const myNode  = decodeAX25Call(payload, 28);
                let detail    = `w=${window} ${myCall} at ${myNode}${flagStr ? ' ' + flagStr : ''}`;
                // BPQ extended params: timeout field after node callsign (payload[35..36])
                if (payload.length > 38) {
                    const timeout = (payload[35] << 8) | payload[36];
                    detail += ` t/o=${timeout}`;
                }
                return { type: 'l4-connect', summary: `NET/ROM CON REQ ${hdr}`, detail, raw: null };
            }
            case NR_CACK: {
                if (flags & NR_FLAG_CHOKE) {
                    return { type: 'l4-connect-ack', summary: `NET/ROM CON NAK ${hdr}`, detail: 'BUSY', raw: null };
                }
                // Window is at payload[21] (byte after opcode+flags at [19], then [20] is first byte of window)
                const window = payload.length > 20 ? payload[20] : '?';
                return { type: 'l4-connect-ack', summary: `NET/ROM CON ACK ${hdr}`, detail: `w=${window} my ckt=${cktStr}`, raw: null };
            }
            case NR_DREQ:
                return { type: 'l4-disc', summary: `NET/ROM DISC REQ ${hdr}`, detail: flagStr, raw: null };
            case NR_DACK:
                return { type: 'l4-disc-ack', summary: `NET/ROM DISC ACK ${hdr}`, detail: flagStr, raw: null };
            case NR_RESET:
                return { type: 'l4-reset', summary: `NET/ROM RESET ${hdr}`, detail: flagStr, raw: null };
            case NR_INFO: {
                const infoText = payload.length > 20 ? decodeInfoBytes(payload, 20, payload.length - 20) : '';
                const detail   = `S${txSeq} R${rxSeq}${flagStr ? ' ' + flagStr : ''}`;
                return { type: 'l4-info', summary: `NET/ROM INFO ${hdr}`, detail, raw: infoText };
            }
            case NR_IACK: {
                const detail = `R${rxSeq}${flagStr ? ' ' + flagStr : ''}`;
                return { type: 'l4-info-ack', summary: `NET/ROM INFO ACK ${hdr}`, detail, raw: null };
            }
            case 0: {
                // Opcode 0 is used for several special NET/ROM extensions
                if (cktIdx === 0x0C && cktId === 0x0C) {
                    // IP-over-NETROM
                    if (payload.length > 20) {
                        const ipd = decodeIPPayload(payload.slice(20));
                        return { type: 'ip', summary: `NET/ROM IP ${ipd.summary}`, detail: ipd.detail, raw: null };
                    }
                    return { type: 'ip', summary: 'NET/ROM IP', detail: '', raw: null };
                }
                if (cktIdx === 0 && cktId === 1) {
                    // NRR — Record Route: list of AX.25 callsigns with H-bit
                    const calls = [];
                    let p = 20;
                    while (p + 8 <= payload.length) {
                        const c = decodeAX25Call(payload, p);
                        const actioned = (payload[p + 7] & 0x80) !== 0;
                        calls.push(c + (actioned ? '*' : ''));
                        p += 8;
                    }
                    return { type: 'l4-unknown', summary: `NET/ROM Record Route ${hdr}`, detail: calls.join(' '), raw: null };
                }
                if (cktIdx === 0x0F) {
                    // NCMP — NET/ROM ICMP-like
                    return { type: 'l4-unknown', summary: `NET/ROM NCMP ${hdr}`, detail: `type=${txSeq} code=${rxSeq}`, raw: null };
                }
                return { type: 'l4-unknown', summary: `NET/ROM op=0 ${hdr}`, detail: `idx=${cktIdx} id=${cktId}`, raw: null };
            }
            default:
                return { type: 'l4-unknown', summary: `NET/ROM op=0x${opcode.toString(16)} ${hdr}`, detail: flagStr, raw: null };
        }
    }

    // ── IP / ARP decoders ─────────────────────────────────────────────────────

    function decodeIPPayload(payload) {
        if (payload.length < 20) return { summary: 'IP (truncated)', detail: '' };

        const ihl      = (payload[0] & 0x0F) * 4;
        const totalLen = (payload[2] << 8) | payload[3];
        const fragWord = (payload[6] << 8) | payload[7];
        const proto    = payload[9];
        const srcIP    = decodeIPv4(payload, 12);
        const dstIP    = decodeIPv4(payload, 16);

        const fragParts = [];
        if (fragWord & 0x4000) fragParts.push('DF');
        if (fragWord & 0x2000) fragParts.push('MF');
        const fragOffset = (fragWord & 0x1FFF) * 8;
        if (fragOffset) fragParts.push(`offset=${fragOffset}`);
        const fragInfo = fragParts.length ? ' ' + fragParts.join(' ') : '';

        let protoInfo = '';
        if (proto === 6 && payload.length >= ihl + 4) {
            const srcPort = (payload[ihl] << 8) | payload[ihl + 1];
            const dstPort = (payload[ihl + 2] << 8) | payload[ihl + 3];
            protoInfo = `TCP :${srcPort}→:${dstPort}`;
        } else if (proto === 17 && payload.length >= ihl + 4) {
            const srcPort = (payload[ihl] << 8) | payload[ihl + 1];
            const dstPort = (payload[ihl + 2] << 8) | payload[ihl + 3];
            protoInfo = `UDP :${srcPort}→:${dstPort}`;
        } else if (proto === 1 && payload.length >= ihl + 2) {
            const icmpType = payload[ihl];
            if      (icmpType === 8) protoInfo = 'ICMP Echo Request';
            else if (icmpType === 0) protoInfo = 'ICMP Echo Reply';
            else                     protoInfo = `ICMP type=${icmpType}`;
        } else {
            protoInfo = `proto=${proto}`;
        }

        return {
            summary: `IP ${srcIP}→${dstIP}`,
            detail:  `${protoInfo} len=${totalLen}${fragInfo}`,
        };
    }

    function decodeARPPayload(payload) {
        // AX.25 ARP: hw=3 (AX.25 6+1 bytes), proto=0x0800 (IP 4 bytes)
        // Layout: [0..1]=hw type, [2..3]=proto type, [4]=hw len, [5]=proto len,
        //         [6..7]=op, [8..14]=sender hw (7-byte AX.25), [15..18]=sender IP,
        //         [19..25]=target hw, [26..29]=target IP
        if (payload.length < 28) return { summary: 'ARP (truncated)', detail: '' };
        const op       = (payload[6] << 8) | payload[7];
        const senderIP = decodeIPv4(payload, 15);
        const targetIP = decodeIPv4(payload, 26);
        if (op === 1) {
            return { summary: `ARP Request: who has ${targetIP}?`, detail: `Tell ${senderIP}` };
        } else if (op === 2) {
            const senderCall = decodeAX25Call(payload, 8);
            return { summary: `ARP Reply: ${senderIP} is at ${senderCall}`, detail: `Tell ${targetIP}` };
        }
        return { summary: `ARP op=${op}`, detail: '' };
    }

    // ── FRMR decoder ──────────────────────────────────────────────────────────

    function decodeFRMR(payload) {
        if (payload.length < 3) return { summary: 'FRMR', detail: '' };
        const rejCtrl = payload[0];
        const vsByte  = payload[1];
        const errByte = payload[2];
        const vs = (vsByte >> 1) & 0x07;
        const vr = (vsByte >> 5) & 0x07;
        const cr = (vsByte & 0x10) ? 'C' : 'R';
        const errParts = [];
        if (errByte & 0x01) errParts.push('W(invalid ctrl)');
        if (errByte & 0x02) errParts.push('X(I in non-I)');
        if (errByte & 0x04) errParts.push('Y(I too long)');
        if (errByte & 0x08) errParts.push('Z(bad N(R))');
        return {
            summary: 'FRMR',
            detail:  `ctrl=0x${rejCtrl.toString(16).padStart(2,'0')} V(S)=${vs} V(R)=${vr} ${cr}${errParts.length ? ' ' + errParts.join(' ') : ''}`,
        };
    }

    // ── XID decoder ───────────────────────────────────────────────────────────

    function decodeXID(payload) {
        if (payload.length < 4 || payload[0] !== 0x82 || payload[1] !== 0x80) {
            return { summary: 'XID', detail: '' };
        }
        const xidLen = (payload[2] << 8) | payload[3];
        let pos = 4;
        let remaining = xidLen;
        const parts = [];

        while (remaining > 0 && pos + 2 <= payload.length) {
            const type = payload[pos++];
            const len  = payload[pos++];
            remaining -= (len + 2);
            let value = 0;
            for (let i = 0; i < len && pos < payload.length; i++) {
                value = (value << 8) | payload[pos++];
            }
            switch (type) {
                case 2:  parts.push('HalfDuplex'); break;
                case 3:  parts.push('FullDuplex'); break;
                case 6:  parts.push(`RX-Paclen=${value / 8}`); break;
                case 8:  parts.push(`RX-Window=${value}`); break;
                case 16: parts.push('CanCompress'); break;
                case 17: parts.push('CompressOK'); break;
                default: parts.push(`t${type}=0x${value.toString(16)}`); break;
            }
        }
        return { summary: 'XID', detail: parts.join(' ') };
    }

    // ── Payload dispatcher (by PID) ───────────────────────────────────────────

    /**
     * Decode a frame payload given its PID byte.
     * isUI: true for UI frames, false for I-frames (affects INP3 RIF detection).
     * Returns { info, infoRaw, frameType, netrom, ip, arp }
     */
    function decodePayload(pid, payload, isUI = true) {
        let info = '', infoRaw = '', frameType = null;
        let netrom = null, ip = null, arp = null;

        switch (pid) {
            case PID_NO_L3: {
                // Normal text data
                infoRaw = decodeInfoBytes(payload, 0, payload.length);
                info = infoRaw;
                break;
            }
            case PID_NETROM: {
                const nr = decodeNetROM(payload, isUI);
                netrom = nr;
                info = nr.summary + (nr.detail ? ': ' + nr.detail : '');
                if (nr.raw) infoRaw = nr.raw;
                // Map NET/ROM sub-type to frameType
                if (nr.type === 'nodes' || nr.type === 'nodes-poll') {
                    frameType = 'nodes';
                } else {
                    frameType = 'netrom';
                }
                break;
            }
            case PID_IP: {
                const ipd = decodeIPPayload(payload);
                ip = ipd;
                info = ipd.summary + (ipd.detail ? ' ' + ipd.detail : '');
                frameType = 'ip';
                break;
            }
            case PID_ARP: {
                const arpd = decodeARPPayload(payload);
                arp = arpd;
                info = arpd.summary + (arpd.detail ? ' ' + arpd.detail : '');
                frameType = 'arp';
                break;
            }
            case PID_FRAG_IP: {
                const fragCount = payload.length > 0 ? payload[0] : 0;
                info = `<Fragmented IP frag=0x${fragCount.toString(16).padStart(2,'0')}>`;
                if (fragCount & 0x80 && payload.length > 2) {
                    // First fragment — decode IP header
                    const ipd = decodeIPPayload(payload.slice(2));
                    info += ' ' + ipd.summary + ' ' + ipd.detail;
                }
                frameType = 'ip';
                break;
            }
            case PID_COMP_L2_1:
            case PID_COMP_L2_2: {
                info = `<${payload.length} bytes compressed L2 data>`;
                break;
            }
            default: {
                // Unknown PID — show hex dump of first 16 bytes
                const hexBytes = Array.from(payload.slice(0, 16))
                    .map(b => b.toString(16).padStart(2,'0'))
                    .join(' ');
                info = `[PID:0x${pid.toString(16).padStart(2,'0')}] ${hexBytes}${payload.length > 16 ? '…' : ''}`;
                break;
            }
        }

        return { info, infoRaw, frameType, netrom, ip, arp };
    }

    // ── Main parse function ───────────────────────────────────────────────────

    /**
     * Parse a raw AX.25 frame (Uint8Array, no KISS framing).
     * Returns a ParsedFrame object or null if the frame is too short/corrupt.
     */
    function parse(bytes) {
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        if (bytes.length < 15) return null;

        try {
            // ── Address field ─────────────────────────────────────────────────

            const destAddr = decodeAddr(bytes, 0);
            const srcAddr  = decodeAddr(bytes, 7);

            // C/R bits from SSID H-bit
            // AX.25 v2.2: dest H=1 + src H=0 → command; dest H=0 + src H=1 → response
            let isCommand = null;
            if  (destAddr.hBit && !srcAddr.hBit)      isCommand = true;
            else if (!destAddr.hBit && srcAddr.hBit)  isCommand = false;

            const dest = fmtCall(destAddr);
            const src  = fmtCall(srcAddr);

            // Digipeaters
            let offset = 14;
            const digipeaters = [];

            if ((bytes[13] & 0x01) === 0) {
                while (offset + 7 <= bytes.length) {
                    const digi       = decodeAddr(bytes, offset);
                    const nextOffset = offset + 7;
                    // Show * on last actioned digi (H-bit set, next digi not actioned or this is last)
                    const nextActioned = (nextOffset + 7 <= bytes.length) ? (bytes[nextOffset + 6] & 0x80) !== 0 : false;
                    const showStar = digi.hBit && (digi.isLast || !nextActioned);
                    digipeaters.push(fmtCall(digi, showStar));
                    offset += 7;
                    if (digi.isLast) break;
                }
            }

            if (offset >= bytes.length) return null;

            // ── Control byte ──────────────────────────────────────────────────

            const ctrl     = bytes[offset++];
            const pf       = (ctrl & 0x10) !== 0;
            const ctrlNoPF = ctrl & ~0x10;

            let frameClass, frameType, ns = null, nr = null;
            let info = '', infoRaw = '', pid = null;
            let netrom = null, ip = null, arp = null, frmr = null;

            const crStr = isCommand === true ? ' C' : isCommand === false ? ' R' : '';
            const pfStr = pf ? (isCommand !== false ? ' P' : ' F') : '';

            if ((ctrl & 0x01) === 0) {
                // ── I-frame ───────────────────────────────────────────────────
                frameClass = 'I';
                frameType  = 'i';
                ns = (ctrl >> 1) & 0x07;
                nr = (ctrl >> 5) & 0x07;
                info = `<I${crStr}${pfStr} S${ns} R${nr}>`;

                if (offset < bytes.length) {
                    pid = bytes[offset++];
                    const payload = bytes.slice(offset);
                    const decoded = decodePayload(pid, payload, false); // I-frame: not UI
                    infoRaw = decoded.infoRaw;
                    if (decoded.info) info += ' ' + decoded.info;
                    netrom = decoded.netrom;
                    ip     = decoded.ip;
                    arp    = decoded.arp;
                    if (decoded.frameType) frameType = decoded.frameType;
                }

            } else if ((ctrl & 0x03) === 0x01) {
                // ── S-frame ───────────────────────────────────────────────────
                frameClass = 'S';
                nr = (ctrl >> 5) & 0x07;
                const nrStr = ` R${nr}`;

                switch (ctrl & 0x0F) {
                    case 0x01: frameType = 'rr';   info = `<RR${crStr}${pfStr}${nrStr}>`;   break;
                    case 0x05: frameType = 'rnr';  info = `<RNR${crStr}${pfStr}${nrStr}>`;  break;
                    case 0x09: frameType = 'rej';  info = `<REJ${crStr}${pfStr}${nrStr}>`;  break;
                    case 0x0D: frameType = 'srej'; info = `<SREJ${crStr}${pfStr}${nrStr}>`; break;
                    default:   frameType = 's';    info = `<S ctrl=0x${ctrl.toString(16).padStart(2,'0')}${nrStr}>`; break;
                }

            } else {
                // ── U-frame ───────────────────────────────────────────────────
                frameClass = 'U';

                switch (ctrlNoPF) {
                    case CTRL_UI: {
                        frameType = 'ui';
                        info = `<UI${crStr}>`;
                        if (offset < bytes.length) {
                            pid = bytes[offset++];
                            const payload = bytes.slice(offset);
                            const decoded = decodePayload(pid, payload, true); // UI frame
                            infoRaw = decoded.infoRaw;
                            if (decoded.info) info += ' ' + decoded.info;
                            netrom = decoded.netrom;
                            ip     = decoded.ip;
                            arp    = decoded.arp;
                            if (decoded.frameType) frameType = decoded.frameType;
                        }
                        break;
                    }
                    case CTRL_SABM:
                        frameType = 'sabm';
                        info = `<SABM${crStr}${pfStr}>`;
                        break;
                    case CTRL_SABME:
                        frameType = 'sabme';
                        info = `<SABME${crStr}${pfStr}>`;
                        break;
                    case CTRL_DISC:
                        frameType = 'disc';
                        info = `<DISC${crStr}${pfStr}>`;
                        break;
                    case CTRL_DM:
                        frameType = 'dm';
                        info = `<DM${crStr}${pfStr}>`;
                        break;
                    case CTRL_UA:
                        frameType = 'ua';
                        info = `<UA${crStr}${pfStr}>`;
                        break;
                    case CTRL_FRMR: {
                        frameType = 'frmr';
                        const frmrPayload = bytes.slice(offset);
                        const f = decodeFRMR(frmrPayload);
                        frmr = f;
                        info = `<FRMR${crStr}${pfStr}> ${f.detail}`;
                        break;
                    }
                    case CTRL_XID: {
                        frameType = 'xid';
                        const xidPayload = bytes.slice(offset);
                        const x = decodeXID(xidPayload);
                        info = `<XID${crStr}${pfStr}>${x.detail ? ' ' + x.detail : ''}`;
                        break;
                    }
                    case CTRL_TEST: {
                        frameType = 'test';
                        const testText = bytes.length > offset
                            ? decodeInfoBytes(bytes, offset, bytes.length - offset)
                            : '';
                        info = `<TEST${crStr}${pfStr}>${testText ? ' ' + testText : ''}`;
                        break;
                    }
                    default:
                        frameType = 'u';
                        info = `<U ctrl=0x${ctrl.toString(16).padStart(2,'0')}${crStr}${pfStr}>`;
                        break;
                }
            }

            // ── APRS detection ────────────────────────────────────────────────
            // APRS: UI frame, PID=0xF0, destination is an APRS tocall
            const isAPRS = frameType === 'ui' && pid === PID_NO_L3;
            if (isAPRS) frameType = 'aprs';

            return {
                from:        src,
                to:          dest,
                digipeaters,
                ctrl,
                frameClass,
                frameType,
                isCommand,
                pollFinal:   pf,
                ns,
                nr,
                pid:         pid !== null ? pid : null,
                pidName:     pid !== null ? pidName(pid) : null,
                info,
                infoRaw,
                isAPRS,
                netrom,
                ip,
                arp,
                frmr,
            };

        } catch (e) {
            console.warn('[AX25Decode] parse error:', e);
            return null;
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return { parse, pidName };

})();

// Confirm the script executed and the global is set
console.log('[AX25Decode] loaded, window.AX25Decode =', typeof window.AX25Decode);
