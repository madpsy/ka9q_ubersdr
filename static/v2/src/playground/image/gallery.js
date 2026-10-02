// The pictures an Image viewer block has received, kept on the page.
//
// Image events (see README.md) arrive with every packet, whether or not the
// playground's window is open — so nothing a two-minute SSTV picture or a
// twenty-minute fax sends is lost while nobody is looking — and are drawn into
// RGBA buffers ready for a canvas: a line is converted once, as it comes, and
// drawing the picture is one putImageData.
//
// A picture whose height is not known (a fax runs until its STOP) grows as
// lines arrive, its buffer doubling. Only so many are kept, oldest first out.

/** One picture. `data` is RGBA, `width` × `capacity` rows; `rows` is how many have arrived. */
export class ImagePicture {
    constructor({ id, mode, width, height, colour }) {
        this.id = id;
        this.mode = mode || '';
        this.width = Math.max(1, width | 0);
        this.height = height > 0 ? height | 0 : null;
        this.colour = colour === 'rgb' ? 'rgb' : 'gray';
        this.capacity = this.height || 64;
        this.data = new Uint8ClampedArray(this.width * this.capacity * 4);
        this.rows = 0;
        this.complete = null;
        this.callsign = null;
        this.started = Date.now();
        this.version = 0;
    }

    /** Room for row y, growing the buffer if the height was not known. */
    _room(y) {
        if (y < this.capacity) return true;
        if (this.height && y >= this.height) return false;
        let cap = this.capacity;
        while (cap <= y) cap *= 2;
        // A picture of no stated height is bounded all the same: a fax that
        // never sends its STOP is not an unbounded allocation.
        cap = Math.min(cap, 8192);
        if (y >= cap) return false;
        const next = new Uint8ClampedArray(this.width * cap * 4);
        next.set(this.data);
        this.data = next;
        this.capacity = cap;
        return true;
    }

    line(y, pixels) {
        if (!(y >= 0) || !pixels || !this._room(y)) return;
        const w = this.width;
        const off = y * w * 4;
        const d = this.data;
        if (this.colour === 'rgb') {
            for (let x = 0; x < w; x++) {
                d[off + 4 * x] = pixels[3 * x];
                d[off + 4 * x + 1] = pixels[3 * x + 1];
                d[off + 4 * x + 2] = pixels[3 * x + 2];
                d[off + 4 * x + 3] = 255;
            }
        } else {
            for (let x = 0; x < w; x++) {
                const v = pixels[x];
                d[off + 4 * x] = v; d[off + 4 * x + 1] = v; d[off + 4 * x + 2] = v; d[off + 4 * x + 3] = 255;
            }
        }
        if (y + 1 > this.rows) this.rows = y + 1;
        this.version++;
    }

    /** The picture as far as it has come: an ImageData-shaped view of the rows so far. */
    view() {
        const rows = Math.max(1, this.rows);
        return { width: this.width, height: rows, data: this.data.subarray(0, this.width * rows * 4) };
    }
}

export class Gallery {
    constructor(keep = 6) {
        this.keep = keep;
        this.pictures = [];
        this.version = 0;
    }

    setKeep(n) {
        this.keep = Math.max(1, Math.min(24, Math.round(n) || 6));
        while (this.pictures.length > this.keep) this.pictures.shift();
    }

    byId(id) {
        for (let i = this.pictures.length - 1; i >= 0; i--) if (this.pictures[i].id === id) return this.pictures[i];
        return null;
    }

    /** One image event. Returns whether anything changed. */
    apply(e) {
        if (!e || e.type !== 'image') return false;
        if (e.event === 'start') {
            this.pictures.push(new ImagePicture(e));
            while (this.pictures.length > this.keep) this.pictures.shift();
        } else if (e.event === 'line') {
            let p = this.byId(e.id);
            // A line for a picture whose start was missed (the block was added
            // mid-picture): one is started for it, of the line's own width.
            if (!p) {
                const rgb = e.pixels && e.width && e.pixels.length === 3 * e.width;
                p = new ImagePicture({ id: e.id, mode: e.mode || '', width: e.width || (e.pixels ? e.pixels.length : 1), height: null, colour: rgb ? 'rgb' : 'gray' });
                this.pictures.push(p);
                while (this.pictures.length > this.keep) this.pictures.shift();
            }
            p.line(e.y, e.pixels);
        } else if (e.event === 'end') {
            const p = this.byId(e.id);
            if (p) { p.complete = !!e.complete; p.version++; }
        } else if (e.event === 'info') {
            const p = this.byId(e.id);
            if (!p) return false;
            if (e.callsign) p.callsign = String(e.callsign).slice(0, 16);
            p.version++;
        } else {
            return false;
        }
        this.version++;
        return true;
    }

    clear() {
        this.pictures = [];
        this.version++;
    }
}
