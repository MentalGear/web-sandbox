// The embedder's side: register the bundle, answer the app's calls, feed it data.
const MAX_TODOS = 1000; // the app stops adding at the same number (app.js)

// An element is one app's for its life: its file registry, its exposed methods, its pending guest writes and every handle
// a host method holds outlive an app that is stopped, so the next app on it would meet the first one's. So each mount makes
// its own element in `container` and returns it with stop(), which ends the app and removes the element; to run another
// app, call mountTodoApp again. `appId` is yours: your own id for this app, never a name the bundle gives itself. It keys
// the app's state in your store, so one app is never handed another's.
export async function mountTodoApp(container, { bundle, appId, store }) {
    const key = `todos:${appId}`;
    const sandbox = document.createElement('web-sandbox');
    let running = true;

    // Built before anything that can fail. After stop() the element is gone: whatever an earlier handler still holds
    // reaches nothing, and the flag keeps a handler that started before it from writing to your store.
    const stop = () => {
        running = false;
        sandbox.terminate();
        sandbox.remove();
    };

    try {
        container.append(sandbox);
        const get = (name) => fetch(`${bundle}/${name}`);
        sandbox.registerFiles({
            'app.js': await (await get('app.js')).text(),
            'app.css': await (await get('app.css')).text(),
            'logo.png': new Uint8Array(await (await get('logo.png')).arrayBuffer()),
        });

        // The app's call runs here with your page's rights, and its argument is the app's data: check its type and size,
        // and keep a copy of what you expect, not the object itself. Array.from visits every index, so a sparse array
        // cannot store holes.
        sandbox.expose('save', async (todos) => {
            if (!Array.isArray(todos) || todos.length > MAX_TODOS) throw new Error(`save: expected at most ${MAX_TODOS} todos`);
            const clean = Array.from(todos, (todo) => {
                if (typeof todo?.text !== 'string' || todo.text.length > 200 || typeof todo.done !== 'boolean') throw new Error('save: bad todo');
                return { text: todo.text, done: todo.done };
            });
            // A call that started before stop() runs on: only its answer is dropped. Check the flag right before the write.
            if (!running) return;
            await store.setItem(key, JSON.stringify(clean));
        });

        sandbox.setConfig({ entry: 'app.js', html: await (await get('app.html')).text(), guestWrites: true });
        await sandbox.call('load', JSON.parse((await store.getItem(key)) ?? '[]')); // queued until the app is ready
    } catch (error) {
        stop(); // a mount that failed leaves nothing running
        throw error;
    }
    return { sandbox, stop }; // the element, to push data to (pushAll), and stop(), to end the app
}

// A stream: the host sends a batch when it has one, and the next only after the app took the last.
export async function pushAll(sandbox, todos, batchSize = 50) {
    for (let at = 0; at < todos.length; at += batchSize) await sandbox.call('push', todos.slice(at, at + batchSize));
}
