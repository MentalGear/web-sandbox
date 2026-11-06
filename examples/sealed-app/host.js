// The embedder's side: register the bundle, answer the app's calls, feed it data.
const MAX_TODOS = 1000; // the app stops adding at the same number (app.js)

// `appId` is yours: your own id for this app, never a name the bundle gives itself. It keys the app's state in your store,
// so one app is never handed another's. Returns stop(), which ends the app and clears the element for the next one.
export async function mountTodoApp(sandbox, { bundle, appId, store }) {
    const key = `todos:${appId}`;
    let running = true;
    const get = (name) => fetch(`${bundle}/${name}`);
    sandbox.registerFiles({
        'app.js': await (await get('app.js')).text(),
        'app.css': await (await get('app.css')).text(),
        'logo.png': new Uint8Array(await (await get('logo.png')).arrayBuffer()),
    });

    // The app's call runs here with your page's rights, and its argument is the app's data: check its type and size,
    // and keep a copy of what you expect, not the object itself.
    sandbox.expose('save', async (todos) => {
        if (!Array.isArray(todos) || todos.length > MAX_TODOS) throw new Error(`save: expected at most ${MAX_TODOS} todos`);
        const clean = todos.map((todo) => {
            if (typeof todo?.text !== 'string' || todo.text.length > 200 || typeof todo.done !== 'boolean') throw new Error('save: bad todo');
            return { text: todo.text, done: todo.done };
        });
        // A call that started before stop() runs on: only its answer is dropped. Check the flag right before the write.
        if (!running) return;
        await store.setItem(key, JSON.stringify(clean));
    });

    sandbox.setConfig({ entry: 'app.js', html: await (await get('app.html')).text(), guestWrites: true });
    await sandbox.call('load', JSON.parse((await store.getItem(key)) ?? '[]')); // queued until the app is ready

    // Stopping the app, or giving the element to another one: methods and files belong to the element, not to the app.
    return function stop() {
        running = false;
        sandbox.terminate();
        sandbox.unexpose();
        sandbox.unregisterFiles();
    };
}

// A stream: the host sends a batch when it has one, and the next only after the app took the last.
export async function pushAll(sandbox, todos, batchSize = 50) {
    for (let at = 0; at < todos.length; at += batchSize) await sandbox.call('push', todos.slice(at, at + batchSize));
}
