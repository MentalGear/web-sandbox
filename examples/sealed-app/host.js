// The embedder's side: register the bundle, answer the app's calls, feed it data.
export async function mountTodoApp(sandbox, { bundle, store }) {
    const get = (name) => fetch(`${bundle}/${name}`);
    sandbox.registerFiles({
        'app.js': await (await get('app.js')).text(),
        'app.css': await (await get('app.css')).text(),
        'logo.png': new Uint8Array(await (await get('logo.png')).arrayBuffer()),
    });

    // The app's call runs here with your page's rights, and its argument is the app's data: check its type and size,
    // and keep a copy of what you expect, not the object itself.
    sandbox.expose('save', (todos) => {
        if (!Array.isArray(todos) || todos.length > 1000) throw new Error('save: expected at most 1000 todos');
        const clean = todos.map((todo) => {
            if (typeof todo?.text !== 'string' || todo.text.length > 200 || typeof todo.done !== 'boolean') throw new Error('save: bad todo');
            return { text: todo.text, done: todo.done };
        });
        store.setItem('todos', JSON.stringify(clean));
    });

    sandbox.setConfig({ entry: 'app.js', html: await (await get('app.html')).text(), guestWrites: true });
    await sandbox.call('load', JSON.parse(store.getItem('todos') ?? '[]')); // queued until the app is ready
}

// A stream: the host sends a batch when it has one, and the next only after the app took the last.
export async function pushAll(sandbox, todos, batchSize = 50) {
    for (let at = 0; at < todos.length; at += batchSize) await sandbox.call('push', todos.slice(at, at + batchSize));
}
