// An Image viewer's picture: the newest (or one stepped back to), drawn as
// it arrives, from the engine's gallery (image/gallery.js). The canvas is the
// picture's own size and the page scales it, so a line is one putImageData
// and nothing is resampled here.

import React, { useEffect, useReducer, useRef, useState } from '../../react.js';
import { Button, Icon } from '../../components/ui.jsx';
import { saveFile } from '../../lib/saveFile.js';

/** A picture as a PNG, through saveFile so the phone apps get it too. */
export async function savePicture(p) {
    if (typeof document === 'undefined' || !p) return false;
    const c = document.createElement('canvas');
    c.width = p.width;
    c.height = Math.max(1, p.rows);
    const ctx = c.getContext && c.getContext('2d');
    if (!ctx) return false;
    const v = p.view();
    ctx.putImageData(new ImageData(new Uint8ClampedArray(v.data), v.width, v.height), 0, 0);
    const blob = await new Promise((done) => c.toBlob(done, 'image/png'));
    if (!blob) return false;
    const when = new Date(p.started).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (v) => v.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    const who = p.callsign ? '-' + slug(p.callsign) : '';
    await saveFile(blob, 'ubersdr-' + slug(p.mode || 'image') + who + '-' + when + '.png');
    return true;
}

export default function ImageView({ pg, node, large = false }) {
    const gallery = pg && pg.galleryOf ? pg.galleryOf(node.id) : null;
    const [, bump] = useReducer((n) => n + 1, 0);
    // Which picture, counted back from the newest; 0 follows each new one.
    const [back, setBack] = useState(0);
    const ref = useRef(null);
    const drawn = useRef({ id: null, version: -1, rows: 0 });
    useEffect(() => {
        if (!pg || !pg.on) return undefined;
        // Redrawn at most once a frame, however many lines a packet brought.
        let queued = false;
        return pg.on('image', (id) => {
            if (id !== node.id || queued) return;
            queued = true;
            const go = () => { queued = false; bump(); };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go); else go();
        });
    }, [pg, node.id]);
    const pics = gallery ? gallery.pictures : [];
    const idx = Math.max(0, pics.length - 1 - Math.min(back, pics.length - 1));
    const p = pics.length ? pics[idx] : null;
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas || !p || typeof ImageData === 'undefined') return;
        const rows = Math.max(1, p.rows);
        const fresh = drawn.current.id !== p.id || canvas.width !== p.width || canvas.height !== rows;
        if (!fresh && drawn.current.version === p.version) return;
        if (canvas.width !== p.width) canvas.width = p.width;
        if (canvas.height !== rows) canvas.height = rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const v = p.view();
        ctx.putImageData(new ImageData(v.data.slice(), v.width, v.height), 0, 0);
        drawn.current = { id: p.id, version: p.version, rows };
    });
    const caption = p
        ? `${p.mode || 'Picture'} · ${p.rows}${p.height ? `/${p.height}` : ''} lines${p.complete === true ? ' · complete' : p.complete === false ? ' · cut short' : ''}${p.callsign ? ' · from ' + p.callsign : ''}`
        : 'Waiting for a picture';
    return (
        <div className={`pg-img${large ? ' is-large' : ''}`}>
            <div className="pg-img__frame">
                {p ? <canvas ref={ref} className="pg-img__canvas" /> : <div className="pg-img__empty">No picture yet</div>}
            </div>
            <div className="pg-img__caption">{caption}</div>
            {large && (
                <div className="pg-insp__row">
                    <Button size="sm" variant="ghost" icon={<Icon.ChevronLeft size={13} />} disabled={!p || idx === 0} onClick={() => setBack(back + 1)} title="An older picture" />
                    <span className="pg-list__dim">{pics.length ? `${idx + 1} of ${pics.length}` : ''}</span>
                    <Button size="sm" variant="ghost" icon={<Icon.ChevronRight size={13} />} disabled={!p || back === 0} onClick={() => setBack(Math.max(0, back - 1))} title="A newer picture" />
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="ghost" icon={<Icon.Download />} disabled={!p || !p.rows} onClick={() => savePicture(p)}>Save PNG</Button>
                    <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} disabled={!pics.length} onClick={() => { pg.clearImages(node.id); setBack(0); }}>Clear</Button>
                </div>
            )}
        </div>
    );
}
