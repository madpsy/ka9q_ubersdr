// Who you are playing against.
//
// The receiver's own callsign, which is what the widget used and what the top bar
// shows: losing to "M9PSY" is a different thing from losing to "the computer", and
// on somebody else's receiver it is the whole joke.
//
// Falls back to the same name the top bar falls back to, for a receiver whose
// operator has not set one — and for the moment before /api/description lands,
// which on a slow connection is long enough to lose a game in.

import { useRadio } from '../../radio/RadioContext.jsx';

export const DEFAULT_OPPONENT = 'UberSDR';

export function useOpponent() {
    const { serverInfo } = useRadio();
    const call = serverInfo && serverInfo.receiver && serverInfo.receiver.callsign;
    return (call && String(call).trim()) || DEFAULT_OPPONENT;
}
