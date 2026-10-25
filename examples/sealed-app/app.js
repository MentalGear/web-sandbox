let todos = [];

async function show() {
    const open = todos.filter((todo) => !todo.done).length;
    sandboxView.render(todos.map((todo, i) =>
        `<li id="todo-${i}"><input type="checkbox" id="done-${i}"${todo.done ? ' checked' : ''}> <span id="text-${i}"></span></li>`).join(''), 'list');
    todos.forEach((todo, i) => sandboxView.text(`text-${i}`, todo.text)); // text, never markup: nothing to escape
    sandboxView.text('count', `${open} open`);

    // an image the app makes: drawn in the worker, written as a file, shown by its path
    const canvas = new OffscreenCanvas(60, 8);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ddd';
    context.fillRect(0, 0, 60, 8);
    context.fillStyle = '#2a7';
    context.fillRect(0, 0, 60 * (todos.length - open) / Math.max(1, todos.length), 8);
    await sandboxFiles.write('progress.png', await canvas.convertToBlob({ type: 'image/png' }));
    sandboxView.render('<img src="progress.png" alt="progress" width="60" height="8">', 'badge');
}

// host -> app
bridge.expose('load', (saved) => { todos = saved; return show(); });
bridge.expose('push', (batch) => { todos.push(...batch); return show(); });

// user -> app -> host
sandboxView.on('submit', 'add', (event) => {
    const text = event.form.find(([name]) => name === 'text')[1].trim().slice(0, 200);
    if (text === '') return;
    todos.push({ text, done: false });
    sandboxView.set('new', { value: '' });
    show().then(() => bridge.call('save', todos));
});
sandboxView.on('change', 'list', (event) => {
    todos[Number(event.ids[0].slice('done-'.length))].done = event.target.checked;
    show().then(() => bridge.call('save', todos));
});
