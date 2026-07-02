'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// notifications-flow.js
// Renders an SVG flow diagram: Event Types → Rules → Channels
// Reads localConfig (rules + channels) from notifications-admin.js global scope.
// Called via renderFlowDiagram() after config loads or saves.
// ═══════════════════════════════════════════════════════════════════════════════

const FLOW_EVENT_EMOJIS = {
    cw_spot:        '🔑',
    dx_spot:        '📡',
    digital_decode: '💻',
    space_weather:  '🌌',
    antenna_switch: '📻',
    rotator:        '🔄',
    system_monitor: '🖥️',
    user_session:   '👤',
    voice_activity: '🎙️',
    server_startup: '🚀',
    digital_rank:   '🏆',
    chat:           '💬',
};

const FLOW_CHANNEL_EMOJIS = {
    telegram: '📱',
    email:    '📧',
    webhook:  '🔗',
};

// ─── Layout constants ────────────────────────────────────────────────────────
const COL_X       = { event: 20,  rule: 290, channel: 580 };
const NODE_W      = { event: 220, rule: 250, channel: 220 };
const NODE_PAD    = 10;   // inner padding px
const NODE_GAP    = 14;   // vertical gap between nodes in same column
const LINE_H_TITLE  = 22; // px per title line
const LINE_H_SUB    = 17; // px per subtitle line
const LINE_H_DETAIL = 15; // px per detail line
const HEADER_H    = 32;   // height reserved for column header labels
const COL_PAD_TOP = HEADER_H + 8; // top padding before first node (below headers)
const MAX_DETAIL_LINES = 5; // max filter lines shown in node before truncation

// ─── Colour palette ──────────────────────────────────────────────────────────
const C = {
    enabledBorder:   '#4caf50',
    enabledFill:     '#f0faf0',
    disabledBorder:  '#bbb',
    disabledFill:    '#f7f7f7',
    eventBorder:     '#1976d2',
    eventFill:       '#e3f0fd',
    channelBorder:   '#7b1fa2',
    channelFill:     '#f5eefa',
    edgeEnabled:     '#4caf50',
    edgeDisabled:    '#ccc',
    titleColor:      '#222',
    subtitleColor:   '#555',
    detailColor:     '#666',
    hoverShadow:     'rgba(0,0,0,0.18)',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flowEventLabel(eventType) {
    // Reuse EVENT_TYPE_LABELS from notifications-admin.js if available
    if (typeof EVENT_TYPE_LABELS !== 'undefined' && EVENT_TYPE_LABELS[eventType]) {
        return EVENT_TYPE_LABELS[eventType];
    }
    return eventType;
}

function flowFilterSummary(eventType, filters) {
    if (!filters || typeof filters !== 'object') return [];
    const fields = (typeof FILTER_FIELDS !== 'undefined' && FILTER_FIELDS[eventType]) || [];
    const lines = [];

    for (const f of fields) {
        if (f.type === 'toggle_on') continue; // default-on, not interesting to show
        const v = filters[f.name];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (f.type === 'bool' && v === false) continue;

        if (Array.isArray(v)) {
            lines.push(f.label + ': ' + v.join(', '));
        } else if (f.type === 'bool') {
            lines.push(f.label + ': yes');
        } else {
            lines.push(f.label + ': ' + v);
        }
    }

    // components is a top-level filter key for system_monitor / server_startup
    if (filters.components && Array.isArray(filters.components) && filters.components.length > 0) {
        // Only add if not already captured by FILTER_FIELDS
        const alreadyCaptured = fields.some(function(f) { return f.name === 'components'; });
        if (!alreadyCaptured) {
            lines.push('Components: ' + filters.components.join(', '));
        }
    }

    return lines;
}

function svgEsc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Truncate a string to maxLen chars with ellipsis
function truncStr(s, maxLen) {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + '…';
}

// ─── Node height calculation ──────────────────────────────────────────────────

function calcEventNodeHeight() {
    // title + subtitle + padding
    return NODE_PAD * 2 + LINE_H_TITLE + LINE_H_SUB;
}

function calcRuleNodeHeight(filterLines) {
    const shown = Math.min(filterLines.length, MAX_DETAIL_LINES);
    const hasMore = filterLines.length > MAX_DETAIL_LINES;
    return NODE_PAD * 2 + LINE_H_TITLE + LINE_H_SUB + shown * LINE_H_DETAIL + (hasMore ? LINE_H_DETAIL : 0);
}

function calcChannelNodeHeight(hasRate) {
    return NODE_PAD * 2 + LINE_H_TITLE + LINE_H_SUB + (hasRate ? LINE_H_DETAIL : 0);
}

// ─── SVG element builders ─────────────────────────────────────────────────────

function svgRect(x, y, w, h, rx, fill, stroke, strokeW, extraAttrs) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
        '" rx="' + rx + '" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="' + strokeW + '"' + (extraAttrs || '') + '/>';
}

function svgText(x, y, text, fontSize, fill, fontWeight, anchor) {
    return '<text x="' + x + '" y="' + y +
        '" font-size="' + fontSize + '" fill="' + fill +
        '" font-weight="' + (fontWeight || 'normal') +
        '" text-anchor="' + (anchor || 'start') + '">' +
        svgEsc(text) + '</text>';
}

function svgPath(d, stroke, strokeW, opacity, extraAttrs) {
    return '<path d="' + d + '" fill="none" stroke="' + stroke +
        '" stroke-width="' + strokeW + '" opacity="' + opacity + '"' +
        (extraAttrs || '') + '/>';
}

// Cubic bezier from (x1,y1) to (x2,y2) with horizontal control points
function bezierPath(x1, y1, x2, y2) {
    const cx = Math.round((x1 + x2) / 2);
    return 'M ' + x1 + ',' + y1 + ' C ' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2;
}

// ─── Main render function ─────────────────────────────────────────────────────

function renderFlowDiagram() {
    const container = document.getElementById('flowDiagram');
    if (!container) return;

    // Guard: localConfig must be available
    if (typeof localConfig === 'undefined') {
        container.innerHTML = '<p style="color:#888;font-style:italic">Config not loaded yet.</p>';
        return;
    }

    const rules    = localConfig.rules    || [];
    const channels = localConfig.channels || {};

    if (rules.length === 0) {
        container.innerHTML = '<p style="color:#888;font-style:italic;padding:12px 0">No rules configured yet. Add rules to see the flow diagram.</p>';
        return;
    }

    // ── 1. Build node data ────────────────────────────────────────────────────

    // Event nodes: one per unique event type used in rules
    const eventMap = {}; // eventType → { label, emoji, ruleCount }
    rules.forEach(function(rule) {
        if (!eventMap[rule.event]) {
            eventMap[rule.event] = {
                type:      rule.event,
                label:     flowEventLabel(rule.event),
                emoji:     FLOW_EVENT_EMOJIS[rule.event] || '📌',
                ruleCount: 0,
            };
        }
        eventMap[rule.event].ruleCount++;
    });

    // Channel nodes: only channels referenced by at least one rule
    const referencedChannelNames = new Set();
    rules.forEach(function(rule) {
        (rule.channels || []).forEach(function(ch) { referencedChannelNames.add(ch); });
    });
    const allChannelNodes = Array.from(referencedChannelNames)
        .filter(function(name) { return channels[name]; })
        .map(function(name) {
            const ch = channels[name];
            return {
                name:  name,
                type:  ch.type || 'telegram',
                emoji: FLOW_CHANNEL_EMOJIS[ch.type] || '📤',
                rate:  ch.rate_limit_minutes > 0 ? ch.rate_limit_minutes : 0,
            };
        });

    // ── 1b. Barycentric ordering to minimise edge crossovers ─────────────────
    // Start with a sensible initial order, then iteratively reorder each column
    // by the median position of its neighbours (3 passes is sufficient).

    let ruleNodes    = rules.slice().sort(function(a, b) {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    let eventNodes   = Object.values(eventMap).sort(function(a, b) { return a.label.localeCompare(b.label); });
    let channelNodes = allChannelNodes.slice().sort(function(a, b) {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return a.name.localeCompare(b.name);
    });

    // Helper: median of an array of numbers
    function median(arr) {
        if (arr.length === 0) return 0;
        const s = arr.slice().sort(function(a, b) { return a - b; });
        const m = Math.floor(s.length / 2);
        return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    }

    // Run 3 passes of barycentric sorting
    for (let pass = 0; pass < 3; pass++) {
        // Build current index maps
        const evIdx = {};  eventNodes.forEach(function(n, i)   { evIdx[n.type]  = i; });
        const chIdx = {};  channelNodes.forEach(function(n, i) { chIdx[n.name]  = i; });

        // Sort rules by median of their connected event index + channel indices
        ruleNodes.sort(function(a, b) {
            const aNeighbours = [evIdx[a.event]].concat(
                (a.channels || []).map(function(c) { return chIdx[c] !== undefined ? chIdx[c] : 0; })
            );
            const bNeighbours = [evIdx[b.event]].concat(
                (b.channels || []).map(function(c) { return chIdx[c] !== undefined ? chIdx[c] : 0; })
            );
            const diff = median(aNeighbours) - median(bNeighbours);
            if (diff !== 0) return diff;
            // Stable tie-break: enabled first, then name
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        // Rebuild rule index after sort
        const ruIdx = {};  ruleNodes.forEach(function(n, i) { ruIdx[n.name] = i; });

        // Sort event nodes by median index of their connected rules
        eventNodes.sort(function(a, b) {
            const aRules = ruleNodes
                .map(function(r, i) { return r.event === a.type ? i : -1; })
                .filter(function(i) { return i >= 0; });
            const bRules = ruleNodes
                .map(function(r, i) { return r.event === b.type ? i : -1; })
                .filter(function(i) { return i >= 0; });
            const diff = median(aRules) - median(bRules);
            return diff !== 0 ? diff : a.label.localeCompare(b.label);
        });

        // Sort channel nodes by median index of their connected rules
        channelNodes.sort(function(a, b) {
            const aRules = ruleNodes
                .map(function(r, i) { return (r.channels || []).indexOf(a.name) >= 0 ? i : -1; })
                .filter(function(i) { return i >= 0; });
            const bRules = ruleNodes
                .map(function(r, i) { return (r.channels || []).indexOf(b.name) >= 0 ? i : -1; })
                .filter(function(i) { return i >= 0; });
            const diff = median(aRules) - median(bRules);
            if (diff !== 0) return diff;
            if (a.type !== b.type) return a.type.localeCompare(b.type);
            return a.name.localeCompare(b.name);
        });
    }

    // ── 2. Pre-compute node heights and Y positions ───────────────────────────

    // Event column
    const eventH = calcEventNodeHeight();
    const eventYs = [];
    let ey = COL_PAD_TOP;
    eventNodes.forEach(function() {
        eventYs.push(ey);
        ey += eventH + NODE_GAP;
    });
    const eventColH = ey - NODE_GAP + COL_PAD_TOP;

    // Rule column
    const ruleHeights = ruleNodes.map(function(rule) {
        const filterLines = flowFilterSummary(rule.event, rule.filters || {});
        const dedupLine = (rule.dedup_window_minutes > 0) ? ['Dedup: ' + rule.dedup_window_minutes + ' min'] : [];
        return { filterLines: filterLines.concat(dedupLine), h: calcRuleNodeHeight(filterLines.concat(dedupLine)) };
    });
    const ruleYs = [];
    let ry = COL_PAD_TOP;
    ruleHeights.forEach(function(rh) {
        ruleYs.push(ry);
        ry += rh.h + NODE_GAP;
    });
    const ruleColH = ry - NODE_GAP + COL_PAD_TOP;

    // Channel column
    const channelHeights = channelNodes.map(function(ch) {
        return calcChannelNodeHeight(ch.rate > 0);
    });
    const channelYs = [];
    let cy = COL_PAD_TOP;
    channelHeights.forEach(function(h) {
        channelYs.push(cy);
        cy += h + NODE_GAP;
    });
    const channelColH = cy - NODE_GAP + COL_PAD_TOP;

    // SVG dimensions
    const svgH = Math.max(eventColH, ruleColH, channelColH) + COL_PAD_TOP;
    const svgW = COL_X.channel + NODE_W.channel + 20;

    // ── 3. Build lookup maps for edge drawing ─────────────────────────────────

    // eventType → index in eventNodes
    const eventIdx = {};
    eventNodes.forEach(function(en, i) { eventIdx[en.type] = i; });

    // channelName → index in channelNodes
    const channelIdx = {};
    channelNodes.forEach(function(cn, i) { channelIdx[cn.name] = i; });

    // ── 4. Build SVG ──────────────────────────────────────────────────────────

    const parts = [];

    // ── 4a. Column header labels ──────────────────────────────────────────────
    const headerY = 16;
    parts.push(svgText(COL_X.event   + NODE_W.event   / 2, headerY, 'Event Types', 11, '#888', '600', 'middle'));
    parts.push(svgText(COL_X.rule    + NODE_W.rule    / 2, headerY, 'Rules',       11, '#888', '600', 'middle'));
    parts.push(svgText(COL_X.channel + NODE_W.channel / 2, headerY, 'Channels',   11, '#888', '600', 'middle'));
    // Separator line under headers
    parts.push('<line x1="0" y1="' + (HEADER_H - 2) + '" x2="' + svgW + '" y2="' + (HEADER_H - 2) + '" stroke="#e0e0e0" stroke-width="1"/>');

    // ── 4b. Edges (drawn first so nodes appear on top) ────────────────────────
    // Group edges by rule index for hover interaction
    ruleNodes.forEach(function(rule, ri) {
        const ruleX1 = COL_X.rule;
        const ruleX2 = COL_X.rule + NODE_W.rule;
        const ruleCY = ruleYs[ri] + ruleHeights[ri].h / 2;

        const enabled = !!rule.enabled;
        const edgeColor = enabled ? C.edgeEnabled : C.edgeDisabled;
        const edgeW = 1.5;
        const edgeOp = enabled ? 0.65 : 0.4;

        // Event → Rule edge
        const ei = eventIdx[rule.event];
        if (ei !== undefined) {
            const evCY = eventYs[ei] + eventH / 2;
            const evX2 = COL_X.event + NODE_W.event;
            parts.push('<g class="flow-edge flow-edge-rule-' + ri + '" data-rule="' + ri + '">');
            parts.push(svgPath(
                bezierPath(evX2, evCY, ruleX1, ruleCY),
                edgeColor, edgeW, edgeOp,
                ' class="flow-edge-path"'
            ));
            parts.push('</g>');
        }

        // Rule → Channel edges
        (rule.channels || []).forEach(function(chName) {
            const ci = channelIdx[chName];
            if (ci === undefined) return;
            const chCY = channelYs[ci] + channelHeights[ci] / 2;
            const chX1 = COL_X.channel;
            parts.push('<g class="flow-edge flow-edge-rule-' + ri + '" data-rule="' + ri + '">');
            parts.push(svgPath(
                bezierPath(ruleX2, ruleCY, chX1, chCY),
                edgeColor, edgeW, edgeOp,
                ' class="flow-edge-path"'
            ));
            parts.push('</g>');
        });
    });

    // ── 4c. Event nodes ───────────────────────────────────────────────────────
    eventNodes.forEach(function(en, i) {
        const x = COL_X.event;
        const y = eventYs[i];
        const w = NODE_W.event;
        const h = eventH;
        const tx = x + NODE_PAD;
        const ruleWord = en.ruleCount === 1 ? 'rule' : 'rules';

        // Build tooltip
        const tooltip = en.emoji + ' ' + en.label + '\n' + en.ruleCount + ' ' + ruleWord;

        parts.push('<g class="flow-node flow-event-node" data-event="' + svgEsc(en.type) + '" style="cursor:default">');
        parts.push('<title>' + svgEsc(tooltip) + '</title>');
        parts.push(svgRect(x, y, w, h, 6, C.eventFill, C.eventBorder, 1.5, ' class="flow-node-rect"'));
        parts.push(svgText(tx, y + NODE_PAD + LINE_H_TITLE - 4, en.emoji + ' ' + truncStr(en.label, 24), 13, C.titleColor, '600'));
        parts.push(svgText(tx, y + NODE_PAD + LINE_H_TITLE + LINE_H_SUB - 4, en.ruleCount + ' ' + ruleWord, 11, C.subtitleColor, 'normal'));
        parts.push('</g>');
    });

    // ── 4d. Rule nodes ────────────────────────────────────────────────────────
    ruleNodes.forEach(function(rule, ri) {
        const x = COL_X.rule;
        const y = ruleYs[ri];
        const w = NODE_W.rule;
        const h = ruleHeights[ri].h;
        const filterLines = ruleHeights[ri].filterLines;
        const tx = x + NODE_PAD;
        const enabled = !!rule.enabled;

        const fill   = enabled ? C.enabledFill   : C.disabledFill;
        const border = enabled ? C.enabledBorder : C.disabledBorder;
        const indicator = enabled ? '✅' : '❌';
        const evLabel = flowEventLabel(rule.event);
        const evEmoji = FLOW_EVENT_EMOJIS[rule.event] || '📌';

        // Build full tooltip
        const tooltipLines = [
            indicator + ' ' + rule.name,
            'Event: ' + evLabel,
        ].concat(filterLines);
        if (rule.channels && rule.channels.length > 0) {
            tooltipLines.push('Channels: ' + rule.channels.join(', '));
        }
        const tooltip = tooltipLines.join('\n');

        parts.push('<g class="flow-node flow-rule-node" data-rule="' + ri + '" style="cursor:pointer">');
        parts.push('<title>' + svgEsc(tooltip) + '</title>');
        parts.push(svgRect(x, y, w, h, 6, fill, border, 1.5, ' class="flow-node-rect"'));

        let lineY = y + NODE_PAD + LINE_H_TITLE - 4;
        parts.push(svgText(tx, lineY, indicator + ' ' + truncStr(rule.name, 26), 13, C.titleColor, '600'));

        lineY += LINE_H_SUB;
        parts.push(svgText(tx, lineY, evEmoji + ' ' + truncStr(evLabel, 26), 11, C.subtitleColor, 'normal'));

        const shownLines = filterLines.slice(0, MAX_DETAIL_LINES);
        const hasMore = filterLines.length > MAX_DETAIL_LINES;
        shownLines.forEach(function(line) {
            lineY += LINE_H_DETAIL;
            parts.push(svgText(tx, lineY, truncStr(line, 32), 10, C.detailColor, 'normal'));
        });
        if (hasMore) {
            lineY += LINE_H_DETAIL;
            parts.push(svgText(tx, lineY, '…' + (filterLines.length - MAX_DETAIL_LINES) + ' more filters', 10, '#999', 'normal'));
        }

        parts.push('</g>');
    });

    // ── 4e. Channel nodes ─────────────────────────────────────────────────────
    channelNodes.forEach(function(ch, ci) {
        const x = COL_X.channel;
        const y = channelYs[ci];
        const w = NODE_W.channel;
        const h = channelHeights[ci];
        const tx = x + NODE_PAD;

        const tooltipLines = [ch.emoji + ' ' + ch.name, ch.type];
        if (ch.rate > 0) tooltipLines.push('Rate limit: ' + ch.rate + ' min');
        const tooltip = tooltipLines.join('\n');

        parts.push('<g class="flow-node flow-channel-node" data-channel="' + svgEsc(ch.name) + '" style="cursor:pointer">');
        parts.push('<title>' + svgEsc(tooltip) + '</title>');
        parts.push(svgRect(x, y, w, h, 6, C.channelFill, C.channelBorder, 1.5, ' class="flow-node-rect"'));

        let lineY = y + NODE_PAD + LINE_H_TITLE - 4;
        parts.push(svgText(tx, lineY, ch.emoji + ' ' + truncStr(ch.name, 24), 13, C.titleColor, '600'));

        lineY += LINE_H_SUB;
        parts.push(svgText(tx, lineY, ch.type, 11, C.subtitleColor, 'normal'));

        if (ch.rate > 0) {
            lineY += LINE_H_DETAIL;
            parts.push(svgText(tx, lineY, 'Rate: ' + ch.rate + ' min', 10, C.detailColor, 'normal'));
        }

        parts.push('</g>');
    });

    // ── 5. Assemble SVG ───────────────────────────────────────────────────────
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"' +
        ' viewBox="0 0 ' + svgW + ' ' + svgH + '"' +
        ' width="100%" style="max-width:' + svgW + 'px;display:block;font-family:system-ui,sans-serif"' +
        ' id="flowSvg">' +
        '<style>' +
        '.flow-node-rect { transition: filter 0.15s; }' +
        '.flow-node:hover .flow-node-rect { filter: drop-shadow(0 2px 6px ' + C.hoverShadow + '); }' +
        '.flow-edge-path { transition: stroke-width 0.15s, opacity 0.15s; }' +
        '.flow-edge.flow-highlighted .flow-edge-path { stroke-width: 3 !important; opacity: 1 !important; }' +
        '.flow-node.flow-highlighted .flow-node-rect { filter: drop-shadow(0 0 6px rgba(0,0,0,0.3)); }' +
        '</style>' +
        parts.join('') +
        '</svg>';

    container.innerHTML = svg;

    // ── 6. Wire hover interactions ────────────────────────────────────────────
    const svgEl = container.querySelector('#flowSvg');
    if (!svgEl) return;

    // Rule node hover: highlight connected edges + event + channel nodes
    svgEl.querySelectorAll('.flow-rule-node').forEach(function(ruleEl) {
        const ri = ruleEl.getAttribute('data-rule');

        ruleEl.addEventListener('mouseenter', function() {
            // Highlight all edges for this rule
            svgEl.querySelectorAll('.flow-edge-rule-' + ri).forEach(function(e) {
                e.classList.add('flow-highlighted');
            });
            // Highlight connected event node
            const rule = ruleNodes[parseInt(ri, 10)];
            if (rule) {
                const evEl = svgEl.querySelector('.flow-event-node[data-event="' + rule.event + '"]');
                if (evEl) evEl.classList.add('flow-highlighted');
                // Highlight connected channel nodes
                (rule.channels || []).forEach(function(chName) {
                    const chEl = svgEl.querySelector('.flow-channel-node[data-channel="' + CSS.escape(chName) + '"]');
                    if (chEl) chEl.classList.add('flow-highlighted');
                });
            }
        });

        ruleEl.addEventListener('mouseleave', function() {
            svgEl.querySelectorAll('.flow-highlighted').forEach(function(e) {
                e.classList.remove('flow-highlighted');
            });
        });

        // Click: navigate to Rules tab
        ruleEl.addEventListener('click', function() {
            const tabEl = document.querySelector('.tab[data-tab="rules"]');
            if (tabEl) tabEl.click();
        });
    });

    // Channel node click: navigate to Channels tab
    svgEl.querySelectorAll('.flow-channel-node').forEach(function(chEl) {
        chEl.addEventListener('click', function() {
            const tabEl = document.querySelector('.tab[data-tab="channels"]');
            if (tabEl) tabEl.click();
        });
    });
}
