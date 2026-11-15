// probe-editing.mjs's output, compactly: per way, the value-changing events (beforeinput, input, change, drop, reset) with
// trusted flag, inputType, target, focused element; and the other events' types.
import { readFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`== ${r.engine} ${r.version}${r.inFrame ? ' (frame)' : ''}`);
    for (const w of r.out) {
        const parts = [];
        for (const e of w.log) {
            if (['beforeinput', 'input', 'change', 'drop', 'reset', 'paste', 'cut', 'compositionstart', 'compositionend'].includes(e.type)) {
                parts.push(`${e.type}${e.trusted ? '' : '(UNTRUSTED)'}${e.inputType !== undefined ? `[${e.inputType}]` : ''}@${e.target}${e.active === e.target ? '*' : `(focus:${e.active || '-'})`}=${JSON.stringify(e.value)}${e.af ? ' AF' : ''}`);
            } else parts.push(`${e.type}${e.trusted ? '' : '(U)'}@${e.target}`);
        }
        console.log(`${w.name}${w.error ? ' ERROR ' + w.error : ''}: ${parts.join(' | ')}`);
    }
}
