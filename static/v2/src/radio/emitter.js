// Minimal event emitter — the connection classes are plain JS and stay
// framework-agnostic; React subscribes to them from the provider.

export class Emitter {
    constructor() {
        this._handlers = new Map();
    }

    on(event, fn) {
        if (!this._handlers.has(event)) this._handlers.set(event, new Set());
        this._handlers.get(event).add(fn);
        return () => this.off(event, fn);
    }

    off(event, fn) {
        const set = this._handlers.get(event);
        if (set) set.delete(fn);
    }

    emit(event, payload) {
        const set = this._handlers.get(event);
        if (!set) return;
        for (const fn of set) {
            try {
                fn(payload);
            } catch (err) {
                console.error(`handler for "${event}" threw`, err);
            }
        }
    }
}
