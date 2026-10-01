// Annotations: notes, headings, group boxes, shapes, arrows and step markers
// on the canvas — for explaining a graph to whoever opens it next.
//
// They are nodes like any block, so they are selected, moved, copied, undone,
// saved and shared the way blocks are; but they have no ports and do nothing
// when the graph runs. `annotation: true` is what the canvas draws them by
// (Canvas.jsx), behind the cards, at the size their settings give
// (geometry.js nodeBox). None of their settings can be driven by a control:
// they are drawing, not signal.

export const ANNOTATION_COLOURS = [
    { value: 'yellow', label: 'Yellow' },
    { value: 'blue', label: 'Blue' },
    { value: 'green', label: 'Green' },
    { value: 'red', label: 'Red' },
    { value: 'purple', label: 'Purple' },
    { value: 'grey', label: 'Grey' },
];

const colour = (fallback, label = 'Colour') => ({
    kind: 'choice', label, default: fallback, options: ANNOTATION_COLOURS, swatches: true,
});
const size = (label, fallback, min) => ({ kind: 'number', label, unit: 'px', default: fallback, min, max: 4000, step: 1, control: false });
const flag = (label, fallback) => ({ kind: 'bool', label, default: fallback, control: false });
const words = (label, fallback, max, multiline = false) => ({ kind: 'text', label, default: fallback, max, multiline, live: true });

// Nothing to do when the graph runs.
const inert = () => ({ configure() {}, reset() {}, process() { return 0; } });

const annotation = (type, label, summary, params) => ({
    type,
    label,
    category: 'Annotate',
    annotation: true,
    summary,
    inputs: [],
    outputs: [],
    params,
    create: inert,
});

export const NoteBlock = annotation('note', 'Note',
    'A sticky note: a few lines on what this part of the graph does. Double-click it to write.', {
        text: words('Text', '', 4000, true),
        colour: colour('yellow'),
        fontSize: { kind: 'choice', label: 'Text size', default: 13, options: [{ value: 11, label: 'S' }, { value: 13, label: 'M' }, { value: 16, label: 'L' }, { value: 20, label: 'XL' }] },
        w: size('Width', 200, 60),
        h: size('Height', 120, 40),
    });

export const HeadingBlock = annotation('heading', 'Heading',
    'Large text with no box round it, to title a graph or a part of one. Double-click it to write.', {
        text: words('Text', 'Heading', 400),
        fontSize: { kind: 'choice', label: 'Size', default: 24, options: [{ value: 16, label: 'S' }, { value: 24, label: 'M' }, { value: 32, label: 'L' }, { value: 44, label: 'XL' }] },
        w: size('Width', 260, 40),
        h: size('Height', 40, 20),
    });

export const GroupBlock = annotation('group', 'Group',
    'A titled box round a part of the graph. Drag it by its title and what is inside goes with it.', {
        title: words('Title', 'Group', 200),
        colour: colour('blue'),
        w: size('Width', 440, 120),
        h: size('Height', 280, 80),
    });

export const RectBlock = annotation('rect', 'Rectangle', 'A box, to point something out.', {
    colour: colour('red'),
    fill: flag('Filled', false),
    dashed: flag('Dashed', false),
    w: size('Width', 160, 16),
    h: size('Height', 100, 16),
});

export const EllipseBlock = annotation('ellipse', 'Ellipse', 'A ring, to circle something.', {
    colour: colour('red'),
    fill: flag('Filled', false),
    dashed: flag('Dashed', false),
    w: size('Width', 140, 16),
    h: size('Height', 90, 16),
});

/**
 * An arrow from its position to `dx`, `dy` further on — either way, so it can
 * point anywhere. Its ends are dragged on the canvas.
 */
export const ArrowBlock = annotation('arrow', 'Arrow', 'An arrow or a plain line. Drag either end to point it.', {
    colour: colour('red'),
    heads: {
        kind: 'choice', label: 'Heads', default: 'end',
        options: [{ value: 'end', label: 'End' }, { value: 'both', label: 'Both' }, { value: 'none', label: 'Line' }],
    },
    thickness: { kind: 'number', label: 'Thickness', unit: 'px', default: 3, min: 1, max: 12, step: 1, control: false },
    dashed: flag('Dashed', false),
    dx: { kind: 'number', label: 'Across', unit: 'px', default: 140, min: -4000, max: 4000, step: 1, control: false },
    dy: { kind: 'number', label: 'Down', unit: 'px', default: 0, min: -4000, max: 4000, step: 1, control: false },
});

// A step marker's size: a round badge, big enough for two digits.
export const MARKER_SIZE = 30;

export const MarkerBlock = annotation('marker', 'Step marker',
    'A numbered badge, for walking someone through a graph: 1, 2, 3…', {
        text: words('Label', '1', 3),
        colour: colour('red'),
    });

export const ANNOTATIONS = [NoteBlock, HeadingBlock, GroupBlock, RectBlock, EllipseBlock, ArrowBlock, MarkerBlock];
