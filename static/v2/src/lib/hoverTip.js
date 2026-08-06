// Placing a readout under a pointer, and knowing when it has stopped asking.
//
// Shared by the panels that put a tooltip on a picture — the rolling
// spectrogram and the band spectrum. Both draw something whose every pixel is a
// measurement, so both want the same answer to "where does the tip go" and the
// same answer to "was that a hover or a tap".

// Where to put the readout relative to the point it describes.
//
// A mouse pointer is a few pixels of arrow and the tip can sit below-right of
// it. A fingertip is not: it covers the thing it just tapped, so on touch the
// tip always goes above, where it can be read while the finger is still down.
// Near the right or bottom edge it flips the other way rather than being
// clamped, so it stays attached to the point it is describing.
// Near the top there is nowhere above to go: a tip flipped up there hangs off
// the picture, and the modal scrolls to reach it — another size change under a
// pointer that was pointing at something.
const TIP_TOP_PCT = 12;

export function tipPlacement(pointerType, xPct, yPct) {
    const touch = pointerType !== 'mouse';
    return {
        left: xPct > 60,
        above: (touch || yPct > 80) && yPct > TIP_TOP_PCT,
    };
}

// Whether losing the pointer should clear the readout.
//
// A mouse leaving the picture has stopped asking. A finger lifting has not —
// the tap was the question, and clearing on pointerup would make the answer
// flash up and vanish, which is what a tap does if you treat it as a hover.
export function readoutClearsOn(pointerType) {
    return pointerType === 'mouse';
}
