// probe-events.mjs's output, compactly: per form, the states and every event after the click.
import { readFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`== ${r.engine} ${r.version} ${r.origin} ${r.enableFeatures.join(',')}`);
    for (const c of r.cases) {
        console.log(`-- ${c.form}\n   load:  ${c.loadState}\n   arrow: ${c.arrowState}\n   end:   ${c.endState}`);
        const parts = [];
        for (const e of c.log) {
            if (e.type === 'pointerup' || e.type === 'keypress') continue;
            const val = ['input', 'change', 'beforeinput'].includes(e.type) ? `=${JSON.stringify(e.value)}` : '';
            parts.push(`${e.step}:${e.type}${e.trusted ? '' : '(U)'}${e.cls && !['Event', 'PointerEvent', 'MouseEvent', 'FocusEvent', 'KeyboardEvent'].includes(e.cls) ? '<' + e.cls + '>' : ''}${e.inputType !== undefined ? `[${e.inputType}]` : ''}${e.key !== undefined ? `{${e.key}}` : ''}@${e.target}${e.active === e.target ? '*' : `(f:${e.active || '-'})`}${val}${e.af ? ' AF' : ''}`);
        }
        console.log('   ' + parts.join('\n   '));
    }
}
