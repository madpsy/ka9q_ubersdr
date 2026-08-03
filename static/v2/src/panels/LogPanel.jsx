import React, { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon } from '../components/ui.jsx';

export default function LogPanel() {
    const { log, actions } = useRadio();
    const endRef = useRef(null);

    useEffect(() => {
        if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
    }, [log.length]);

    return (
        <div className="stack stack--fill">
            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Close />} onClick={actions.clearLog}>Clear</Button>
            </div>
            <div className="log">
                {log.length === 0 && <Empty>Nothing logged yet.</Empty>}
                {log.map((e) => (
                    <div key={e.id} className={`log__row log__row--${e.level}`}>
                        <span className="log__time">{e.at.toLocaleTimeString()}</span>
                        <span className="log__text">{e.text}</span>
                    </div>
                ))}
                <div ref={endRef} />
            </div>
        </div>
    );
}
