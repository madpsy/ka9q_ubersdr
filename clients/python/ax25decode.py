"""
ax25decode.py — Comprehensive AX.25 frame decoder.

Ported from ax25decode.js (which was itself ported from LinBPQ/BPQ32 Moncode.c).

Public API:
    parse(data: bytes | bytearray) -> dict | None

Returned dict keys (all present, some may be None):
    from, to, digipeaters, ctrl, frame_class, frame_type,
    is_command, poll_final, ns, nr, pid, pid_name,
    info, info_raw, is_aprs, netrom, ip, arp, frmr
"""

# ── AX.25 / NET/ROM constants ─────────────────────────────────────────────────

PID_NETROM    = 0xCF
PID_IP        = 0xCC
PID_ARP       = 0xCD
PID_FRAG_IP   = 0x08
PID_NO_L3     = 0xF0
PID_COMP_L2_1 = 0xF1
PID_COMP_L2_2 = 0xF2

# U-frame control values (P/F bit masked out)
CTRL_UI    = 0x03
CTRL_SABM  = 0x2F
CTRL_SABME = 0x6F
CTRL_DISC  = 0x43
CTRL_DM    = 0x0F
CTRL_UA    = 0x63
CTRL_FRMR  = 0x87
CTRL_XID   = 0xAF
CTRL_TEST  = 0xE3

# NET/ROM L4 opcodes
NR_CREQ  = 0x01
NR_CACK  = 0x02
NR_DREQ  = 0x03
NR_DACK  = 0x04
NR_INFO  = 0x05
NR_IACK  = 0x06
NR_RESET = 0x07

# NET/ROM L4 flags
NR_FLAG_CHOKE = 0x80
NR_FLAG_NAK   = 0x40
NR_FLAG_MORE  = 0x20
NR_FLAG_COMP  = 0x10

NODES_SIG = 0xFF

# ── Address helpers ───────────────────────────────────────────────────────────

def _decode_addr(data: bytes, offset: int) -> dict:
    """Decode a 7-byte AX.25 address field."""
    call = ''
    for i in range(6):
        ch = data[offset + i] >> 1
        if ch != 0x20 and ch != 0x00:
            call += chr(ch)
    call = call.strip()
    ssid_byte = data[offset + 6]
    ssid    = (ssid_byte >> 1) & 0x0F
    h_bit   = bool(ssid_byte & 0x80)
    is_last = bool(ssid_byte & 0x01)
    call_str = f'{call}-{ssid}' if ssid > 0 else call
    return {'call': call_str, 'ssid': ssid, 'h_bit': h_bit, 'is_last': is_last}


def _fmt_call(addr: dict, show_star: bool = False) -> str:
    return addr['call'] + ('*' if show_star and addr['h_bit'] else '')


def _decode_ax25_call(data: bytes, offset: int) -> str:
    if offset + 7 > len(data):
        return '?'
    return _decode_addr(data, offset)['call']


def _decode_alias(data: bytes, offset: int, length: int) -> str:
    s = ''
    for i in range(length):
        if offset + i >= len(data):
            break
        c = data[offset + i]
        if c == 0 or c == 0x20:
            break
        s += chr(c)
    return s.strip()


def _decode_ipv4(data: bytes, offset: int) -> str:
    return f'{data[offset]}.{data[offset+1]}.{data[offset+2]}.{data[offset+3]}'


def _decode_info_bytes(data: bytes, offset: int, length: int) -> str:
    """Decode info field bytes to a printable string."""
    sl = data[offset:offset + length]
    try:
        s = sl.decode('utf-8', errors='strict')
        # Strip control chars except CR/LF
        return ''.join(c for c in s if c == '\r' or c == '\n' or ord(c) >= 0x20)
    except Exception:
        s = ''
        for b in sl:
            c = b & 0x7F
            if c == 0x0D or c == 0x0A or c >= 0x20:
                s += chr(c)
        return s


# ── PID name lookup ───────────────────────────────────────────────────────────

_PID_NAMES = {
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
}

def _pid_name(pid: int) -> str:
    return _PID_NAMES.get(pid, f'0x{pid:02x}')


# ── NET/ROM decoder ───────────────────────────────────────────────────────────

def _decode_inp3_rif(payload: bytes) -> dict:
    """Decode an INP3 Routing Information Frame (RIF)."""
    entries = []
    pos = 0
    remaining = len(payload)

    while remaining > 9:
        if pos + 7 > len(payload):
            break
        call = _decode_ax25_call(payload, pos)
        pos += 7
        remaining -= 7

        if remaining < 3:
            break
        hops = payload[pos]
        rtt  = (payload[pos + 1] << 8) | payload[pos + 2]
        pos += 3
        remaining -= 3

        alias = ''
        while remaining > 0 and payload[pos] != 0:
            tlv_len    = payload[pos]
            tlv_opcode = payload[pos + 1] if pos + 1 < len(payload) else 0
            if tlv_len < 2 or tlv_len > remaining:
                break
            if tlv_opcode == 0 and tlv_len <= 8:
                alias = _decode_alias(payload, pos + 2, tlv_len - 2)
            pos += tlv_len
            remaining -= tlv_len

        if remaining > 0 and payload[pos] == 0:
            pos += 1
            remaining -= 1

        entries.append(f'{alias or call}:{call} hops={hops} rtt={rtt}ms')

    return {
        'type': 'nodes',
        'summary': 'INP3 RIF',
        'detail': ', '.join(entries),
        'entries': entries,
        'raw': None,
    }


def _decode_nodes(payload: bytes, is_ui: bool = True) -> dict:
    """Decode a NET/ROM NODES broadcast."""
    if not is_ui:
        return _decode_inp3_rif(payload[1:])

    if len(payload) < 7:
        return {'type': 'nodes', 'summary': 'NODES (truncated)', 'detail': '', 'entries': [], 'raw': None}

    alias = _decode_alias(payload, 1, 6)
    entries = []
    pos = 7
    while pos + 21 <= len(payload):
        dest     = _decode_ax25_call(payload, pos);     pos += 7
        ent_alias = _decode_alias(payload, pos, 6);     pos += 6
        node     = _decode_ax25_call(payload, pos);     pos += 7
        quality  = payload[pos];                         pos += 1
        entries.append(f'{ent_alias or dest}:{dest} via {node} qlty={quality}')

    return {
        'type': 'nodes',
        'summary': f'NODES from {alias}',
        'detail': ', '.join(entries),
        'entries': entries,
        'raw': None,
    }


def _decode_netrom(payload: bytes, is_ui: bool = True) -> dict:
    if len(payload) < 1:
        return {'type': 'netrom', 'summary': 'NET/ROM (empty)', 'detail': '', 'raw': None}

    if payload[0] == NODES_SIG:
        return _decode_nodes(payload, is_ui)

    if payload[0] == 0xFE:
        alias = _decode_alias(payload, 1, 6)
        return {'type': 'nodes-poll', 'summary': f'NET/ROM NODES POLL from {alias}', 'detail': '', 'raw': None}

    if len(payload) < 20:
        return {'type': 'netrom', 'summary': 'NET/ROM (truncated)', 'detail': '', 'raw': None}

    dest    = _decode_ax25_call(payload, 0)
    origin  = _decode_ax25_call(payload, 7)
    ttl     = payload[14]
    ckt_idx = payload[15]
    ckt_id  = payload[16]
    tx_seq  = payload[17]
    rx_seq  = payload[18]
    op_byte = payload[19]
    opcode  = op_byte & 0x0F
    flags   = op_byte & 0xF0

    ckt_str = f'{ckt_idx:02x}{ckt_id:02x}'
    flag_parts = []
    if flags & NR_FLAG_CHOKE: flag_parts.append('CHOKE')
    if flags & NR_FLAG_NAK:   flag_parts.append('NAK')
    if flags & NR_FLAG_MORE:  flag_parts.append('MORE')
    if flags & NR_FLAG_COMP:  flag_parts.append('COMP')
    flag_str = ' '.join(flag_parts)

    hdr = f'{origin}→{dest} ttl={ttl} ckt={ckt_str}'

    if opcode == NR_CREQ:
        if len(payload) < 35:
            return {'type': 'l4-connect', 'summary': f'NET/ROM CON REQ {hdr}', 'detail': '', 'raw': None}
        window  = payload[20]
        my_call = _decode_ax25_call(payload, 21)
        my_node = _decode_ax25_call(payload, 28)
        detail  = f'w={window} {my_call} at {my_node}' + (f' {flag_str}' if flag_str else '')
        if len(payload) > 38:
            timeout = (payload[35] << 8) | payload[36]
            detail += f' t/o={timeout}'
        return {'type': 'l4-connect', 'summary': f'NET/ROM CON REQ {hdr}', 'detail': detail, 'raw': None}

    elif opcode == NR_CACK:
        if flags & NR_FLAG_CHOKE:
            return {'type': 'l4-connect-ack', 'summary': f'NET/ROM CON NAK {hdr}', 'detail': 'BUSY', 'raw': None}
        window = payload[20] if len(payload) > 20 else '?'
        return {'type': 'l4-connect-ack', 'summary': f'NET/ROM CON ACK {hdr}', 'detail': f'w={window} my ckt={ckt_str}', 'raw': None}

    elif opcode == NR_DREQ:
        return {'type': 'l4-disc', 'summary': f'NET/ROM DISC REQ {hdr}', 'detail': flag_str, 'raw': None}

    elif opcode == NR_DACK:
        return {'type': 'l4-disc-ack', 'summary': f'NET/ROM DISC ACK {hdr}', 'detail': flag_str, 'raw': None}

    elif opcode == NR_RESET:
        return {'type': 'l4-reset', 'summary': f'NET/ROM RESET {hdr}', 'detail': flag_str, 'raw': None}

    elif opcode == NR_INFO:
        info_text = _decode_info_bytes(payload, 20, len(payload) - 20) if len(payload) > 20 else ''
        detail    = f'S{tx_seq} R{rx_seq}' + (f' {flag_str}' if flag_str else '')
        return {'type': 'l4-info', 'summary': f'NET/ROM INFO {hdr}', 'detail': detail, 'raw': info_text}

    elif opcode == NR_IACK:
        detail = f'R{rx_seq}' + (f' {flag_str}' if flag_str else '')
        return {'type': 'l4-info-ack', 'summary': f'NET/ROM INFO ACK {hdr}', 'detail': detail, 'raw': None}

    elif opcode == 0:
        if ckt_idx == 0x0C and ckt_id == 0x0C:
            if len(payload) > 20:
                ipd = _decode_ip_payload(payload[20:])
                return {'type': 'ip', 'summary': f'NET/ROM IP {ipd["summary"]}', 'detail': ipd['detail'], 'raw': None}
            return {'type': 'ip', 'summary': 'NET/ROM IP', 'detail': '', 'raw': None}
        if ckt_idx == 0 and ckt_id == 1:
            calls = []
            p = 20
            while p + 8 <= len(payload):
                c = _decode_ax25_call(payload, p)
                actioned = bool(payload[p + 7] & 0x80)
                calls.append(c + ('*' if actioned else ''))
                p += 8
            return {'type': 'l4-unknown', 'summary': f'NET/ROM Record Route {hdr}', 'detail': ' '.join(calls), 'raw': None}
        if ckt_idx == 0x0F:
            return {'type': 'l4-unknown', 'summary': f'NET/ROM NCMP {hdr}', 'detail': f'type={tx_seq} code={rx_seq}', 'raw': None}
        return {'type': 'l4-unknown', 'summary': f'NET/ROM op=0 {hdr}', 'detail': f'idx={ckt_idx} id={ckt_id}', 'raw': None}

    else:
        return {'type': 'l4-unknown', 'summary': f'NET/ROM op=0x{opcode:x} {hdr}', 'detail': flag_str, 'raw': None}


# ── IP / ARP decoders ─────────────────────────────────────────────────────────

def _decode_ip_payload(payload: bytes) -> dict:
    if len(payload) < 20:
        return {'summary': 'IP (truncated)', 'detail': ''}

    ihl       = (payload[0] & 0x0F) * 4
    total_len = (payload[2] << 8) | payload[3]
    frag_word = (payload[6] << 8) | payload[7]
    proto     = payload[9]
    src_ip    = _decode_ipv4(payload, 12)
    dst_ip    = _decode_ipv4(payload, 16)

    frag_parts = []
    if frag_word & 0x4000: frag_parts.append('DF')
    if frag_word & 0x2000: frag_parts.append('MF')
    frag_offset = (frag_word & 0x1FFF) * 8
    if frag_offset: frag_parts.append(f'offset={frag_offset}')
    frag_info = (' ' + ' '.join(frag_parts)) if frag_parts else ''

    proto_info = ''
    if proto == 6 and len(payload) >= ihl + 4:
        src_port = (payload[ihl] << 8) | payload[ihl + 1]
        dst_port = (payload[ihl + 2] << 8) | payload[ihl + 3]
        proto_info = f'TCP :{src_port}→:{dst_port}'
    elif proto == 17 and len(payload) >= ihl + 4:
        src_port = (payload[ihl] << 8) | payload[ihl + 1]
        dst_port = (payload[ihl + 2] << 8) | payload[ihl + 3]
        proto_info = f'UDP :{src_port}→:{dst_port}'
    elif proto == 1 and len(payload) >= ihl + 2:
        icmp_type = payload[ihl]
        if   icmp_type == 8: proto_info = 'ICMP Echo Request'
        elif icmp_type == 0: proto_info = 'ICMP Echo Reply'
        else:                proto_info = f'ICMP type={icmp_type}'
    else:
        proto_info = f'proto={proto}'

    return {
        'summary': f'IP {src_ip}→{dst_ip}',
        'detail':  f'{proto_info} len={total_len}{frag_info}',
    }


def _decode_arp_payload(payload: bytes) -> dict:
    if len(payload) < 28:
        return {'summary': 'ARP (truncated)', 'detail': ''}
    op        = (payload[6] << 8) | payload[7]
    sender_ip = _decode_ipv4(payload, 15)
    target_ip = _decode_ipv4(payload, 26)
    if op == 1:
        return {'summary': f'ARP Request: who has {target_ip}?', 'detail': f'Tell {sender_ip}'}
    elif op == 2:
        sender_call = _decode_ax25_call(payload, 8)
        return {'summary': f'ARP Reply: {sender_ip} is at {sender_call}', 'detail': f'Tell {target_ip}'}
    return {'summary': f'ARP op={op}', 'detail': ''}


# ── FRMR decoder ──────────────────────────────────────────────────────────────

def _decode_frmr(payload: bytes) -> dict:
    if len(payload) < 3:
        return {'summary': 'FRMR', 'detail': ''}
    rej_ctrl = payload[0]
    vs_byte  = payload[1]
    err_byte = payload[2]
    vs = (vs_byte >> 1) & 0x07
    vr = (vs_byte >> 5) & 0x07
    cr = 'C' if (vs_byte & 0x10) else 'R'
    err_parts = []
    if err_byte & 0x01: err_parts.append('W(invalid ctrl)')
    if err_byte & 0x02: err_parts.append('X(I in non-I)')
    if err_byte & 0x04: err_parts.append('Y(I too long)')
    if err_byte & 0x08: err_parts.append('Z(bad N(R))')
    return {
        'summary': 'FRMR',
        'detail':  f'ctrl=0x{rej_ctrl:02x} V(S)={vs} V(R)={vr} {cr}' + ((' ' + ' '.join(err_parts)) if err_parts else ''),
    }


# ── XID decoder ───────────────────────────────────────────────────────────────

def _decode_xid(payload: bytes) -> dict:
    if len(payload) < 4 or payload[0] != 0x82 or payload[1] != 0x80:
        return {'summary': 'XID', 'detail': ''}
    xid_len = (payload[2] << 8) | payload[3]
    pos = 4
    remaining = xid_len
    parts = []

    while remaining > 0 and pos + 2 <= len(payload):
        t   = payload[pos]; pos += 1
        ln  = payload[pos]; pos += 1
        remaining -= (ln + 2)
        value = 0
        for _ in range(ln):
            if pos < len(payload):
                value = (value << 8) | payload[pos]
                pos += 1
        if   t == 2:  parts.append('HalfDuplex')
        elif t == 3:  parts.append('FullDuplex')
        elif t == 6:  parts.append(f'RX-Paclen={value // 8}')
        elif t == 8:  parts.append(f'RX-Window={value}')
        elif t == 16: parts.append('CanCompress')
        elif t == 17: parts.append('CompressOK')
        else:         parts.append(f't{t}=0x{value:x}')

    return {'summary': 'XID', 'detail': ' '.join(parts)}


# ── Payload dispatcher (by PID) ───────────────────────────────────────────────

def _decode_payload(pid: int, payload: bytes, is_ui: bool = True) -> dict:
    """Decode a frame payload given its PID byte."""
    info = ''
    info_raw = ''
    frame_type = None
    netrom = None
    ip = None
    arp = None

    if pid == PID_NO_L3:
        info_raw = _decode_info_bytes(payload, 0, len(payload))
        info = info_raw

    elif pid == PID_NETROM:
        nr = _decode_netrom(payload, is_ui)
        netrom = nr
        info = nr['summary'] + (': ' + nr['detail'] if nr['detail'] else '')
        if nr.get('raw'):
            info_raw = nr['raw']
        if nr['type'] in ('nodes', 'nodes-poll'):
            frame_type = 'nodes'
        else:
            frame_type = 'netrom'

    elif pid == PID_IP:
        ipd = _decode_ip_payload(payload)
        ip = ipd
        info = ipd['summary'] + (' ' + ipd['detail'] if ipd['detail'] else '')
        frame_type = 'ip'

    elif pid == PID_ARP:
        arpd = _decode_arp_payload(payload)
        arp = arpd
        info = arpd['summary'] + (' ' + arpd['detail'] if arpd['detail'] else '')
        frame_type = 'arp'

    elif pid == PID_FRAG_IP:
        frag_count = payload[0] if len(payload) > 0 else 0
        info = f'<Fragmented IP frag=0x{frag_count:02x}>'
        if (frag_count & 0x80) and len(payload) > 2:
            ipd = _decode_ip_payload(payload[2:])
            info += ' ' + ipd['summary'] + ' ' + ipd['detail']
        frame_type = 'ip'

    elif pid in (PID_COMP_L2_1, PID_COMP_L2_2):
        info = f'<{len(payload)} bytes compressed L2 data>'

    else:
        hex_bytes = ' '.join(f'{b:02x}' for b in payload[:16])
        info = f'[PID:0x{pid:02x}] {hex_bytes}' + ('…' if len(payload) > 16 else '')

    return {'info': info, 'info_raw': info_raw, 'frame_type': frame_type,
            'netrom': netrom, 'ip': ip, 'arp': arp}


# ── Main parse function ───────────────────────────────────────────────────────

def parse(data) -> dict | None:
    """
    Parse a raw AX.25 frame (bytes/bytearray, no KISS framing).
    Returns a dict or None if the frame is too short/corrupt.
    """
    if not isinstance(data, (bytes, bytearray)):
        data = bytes(data)
    if len(data) < 15:
        return None

    try:
        # ── Address field ─────────────────────────────────────────────────────
        dest_addr = _decode_addr(data, 0)
        src_addr  = _decode_addr(data, 7)

        # C/R bits from SSID H-bit
        is_command = None
        if dest_addr['h_bit'] and not src_addr['h_bit']:
            is_command = True
        elif not dest_addr['h_bit'] and src_addr['h_bit']:
            is_command = False

        dest = _fmt_call(dest_addr)
        src  = _fmt_call(src_addr)

        # Digipeaters
        offset = 14
        digipeaters = []

        if (data[13] & 0x01) == 0:
            while offset + 7 <= len(data):
                digi        = _decode_addr(data, offset)
                next_offset = offset + 7
                next_actioned = (next_offset + 7 <= len(data)) and bool(data[next_offset + 6] & 0x80)
                show_star = digi['h_bit'] and (digi['is_last'] or not next_actioned)
                digipeaters.append(_fmt_call(digi, show_star))
                offset += 7
                if digi['is_last']:
                    break

        if offset >= len(data):
            return None

        # ── Control byte ──────────────────────────────────────────────────────
        ctrl      = data[offset]; offset += 1
        pf        = bool(ctrl & 0x10)
        ctrl_no_pf = ctrl & ~0x10

        frame_class = None
        frame_type  = None
        ns = None
        nr = None
        info = ''
        info_raw = ''
        pid = None
        netrom = None
        ip = None
        arp = None
        frmr = None

        cr_str = ' C' if is_command is True else (' R' if is_command is False else '')
        pf_str = (' P' if is_command is not False else ' F') if pf else ''

        if (ctrl & 0x01) == 0:
            # ── I-frame ───────────────────────────────────────────────────────
            frame_class = 'I'
            frame_type  = 'i'
            ns = (ctrl >> 1) & 0x07
            nr = (ctrl >> 5) & 0x07
            info = f'<I{cr_str}{pf_str} S{ns} R{nr}>'

            if offset < len(data):
                pid = data[offset]; offset += 1
                payload = data[offset:]
                decoded = _decode_payload(pid, payload, is_ui=False)
                info_raw = decoded['info_raw']
                if decoded['info']:
                    info += ' ' + decoded['info']
                netrom = decoded['netrom']
                ip     = decoded['ip']
                arp    = decoded['arp']
                if decoded['frame_type']:
                    frame_type = decoded['frame_type']

        elif (ctrl & 0x03) == 0x01:
            # ── S-frame ───────────────────────────────────────────────────────
            frame_class = 'S'
            nr = (ctrl >> 5) & 0x07
            nr_str = f' R{nr}'

            s_type = ctrl & 0x0F
            if   s_type == 0x01: frame_type = 'rr';   info = f'<RR{cr_str}{pf_str}{nr_str}>'
            elif s_type == 0x05: frame_type = 'rnr';  info = f'<RNR{cr_str}{pf_str}{nr_str}>'
            elif s_type == 0x09: frame_type = 'rej';  info = f'<REJ{cr_str}{pf_str}{nr_str}>'
            elif s_type == 0x0D: frame_type = 'srej'; info = f'<SREJ{cr_str}{pf_str}{nr_str}>'
            else:                frame_type = 's';    info = f'<S ctrl=0x{ctrl:02x}{nr_str}>'

        else:
            # ── U-frame ───────────────────────────────────────────────────────
            frame_class = 'U'

            if ctrl_no_pf == CTRL_UI:
                frame_type = 'ui'
                info = f'<UI{cr_str}>'
                if offset < len(data):
                    pid = data[offset]; offset += 1
                    payload = data[offset:]
                    decoded = _decode_payload(pid, payload, is_ui=True)
                    info_raw = decoded['info_raw']
                    if decoded['info']:
                        info += ' ' + decoded['info']
                    netrom = decoded['netrom']
                    ip     = decoded['ip']
                    arp    = decoded['arp']
                    if decoded['frame_type']:
                        frame_type = decoded['frame_type']

            elif ctrl_no_pf == CTRL_SABM:
                frame_type = 'sabm';  info = f'<SABM{cr_str}{pf_str}>'
            elif ctrl_no_pf == CTRL_SABME:
                frame_type = 'sabme'; info = f'<SABME{cr_str}{pf_str}>'
            elif ctrl_no_pf == CTRL_DISC:
                frame_type = 'disc';  info = f'<DISC{cr_str}{pf_str}>'
            elif ctrl_no_pf == CTRL_DM:
                frame_type = 'dm';    info = f'<DM{cr_str}{pf_str}>'
            elif ctrl_no_pf == CTRL_UA:
                frame_type = 'ua';    info = f'<UA{cr_str}{pf_str}>'
            elif ctrl_no_pf == CTRL_FRMR:
                frame_type = 'frmr'
                frmr_payload = data[offset:]
                f = _decode_frmr(frmr_payload)
                frmr = f
                info = f'<FRMR{cr_str}{pf_str}> {f["detail"]}'

            elif ctrl_no_pf == CTRL_XID:
                frame_type = 'xid'
                xid_payload = data[offset:]
                x = _decode_xid(xid_payload)
                info = f'<XID{cr_str}{pf_str}>' + (f' {x["detail"]}' if x['detail'] else '')

            elif ctrl_no_pf == CTRL_TEST:
                frame_type = 'test'
                test_text = _decode_info_bytes(data, offset, len(data) - offset) if len(data) > offset else ''
                info = f'<TEST{cr_str}{pf_str}>' + (f' {test_text}' if test_text else '')

            else:
                frame_type = 'u'
                info = f'<U ctrl=0x{ctrl:02x}{cr_str}{pf_str}>'

        # ── APRS detection ────────────────────────────────────────────────────
        # APRS: UI frame, PID=0xF0, destination is an APRS tocall
        is_aprs = (frame_type == 'ui' and pid == PID_NO_L3)
        if is_aprs:
            frame_type = 'aprs'

        return {
            'from':        src,
            'to':          dest,
            'digipeaters': digipeaters,
            'ctrl':        ctrl,
            'frame_class': frame_class,
            'frame_type':  frame_type,
            'is_command':  is_command,
            'poll_final':  pf,
            'ns':          ns,
            'nr':          nr,
            'pid':         pid,
            'pid_name':    _pid_name(pid) if pid is not None else None,
            'info':        info,
            'info_raw':    info_raw,
            'is_aprs':     is_aprs,
            'netrom':      netrom,
            'ip':          ip,
            'arp':         arp,
            'frmr':        frmr,
        }

    except Exception as e:
        import traceback
        print(f'[ax25decode] parse error: {e}\n{traceback.format_exc()}')
        return None