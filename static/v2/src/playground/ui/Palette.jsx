// The left-hand column: every block, by category, and a box to find one.
// Pressing one adds it to the canvas where it can be seen.

import React, { useState } from '../../react.js';
import { BLOCKS, CATEGORIES } from '../blocks/index.js';

export default function Palette({ onAdd }) {
    const [q, setQ] = useState('');
    const needle = q.trim().toLowerCase();
    const match = (b) => !needle
        || b.label.toLowerCase().includes(needle)
        || b.summary.toLowerCase().includes(needle)
        || b.type.includes(needle);
    return (
        <div className="pg-pal">
            <input
                className="input pg-pal__search"
                placeholder="Find a block"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
            />
            {CATEGORIES.map((cat) => {
                const items = BLOCKS.filter((b) => b.category === cat && match(b));
                if (!items.length) return null;
                return (
                    <div key={cat} className="pg-pal__cat">
                        <div className="pg-pal__title">{cat}</div>
                        {items.map((b) => (
                            <button
                                key={b.type}
                                type="button"
                                className="pg-pal__item"
                                title={b.summary}
                                onClick={() => onAdd(b.type)}
                            >
                                {b.label}
                            </button>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}
