export function expandCommand(command, timestamp = Math.floor(Date.now() / 1000)) {
    return command.replaceAll('{timestamp}', String(timestamp));
}

export default function initCommandPanel(sendCommand) {
    const toggle = document.getElementById('commandsButton');
    const panel = document.getElementById('commandsPanel');
    const close = document.getElementById('closeCommandsButton');
    const list = document.getElementById('savedCommands');
    const status = document.getElementById('commandsStatus');
    const form = document.getElementById('commandCreateForm');
    const nameInput = document.getElementById('commandName');
    const commandInput = document.getElementById('commandText');
    let commands = [];
    let loaded = false;
    let busy = false;

    function setStatus(message, error = false) {
        status.textContent = message;
        status.dataset.error = String(error);
    }

    function setBusy(value) {
        busy = value;
        panel.querySelectorAll('.commands-content button, .commands-content input')
            .forEach(element => { element.disabled = value; });
    }

    async function requestCommands(options = {}) {
        const response = await fetch('/commands', {
            ...options,
            signal: AbortSignal.timeout(8000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Falha ao acessar os comandos.');
        if (!Array.isArray(data.commands)) throw new Error('Lista de comandos inválida.');
        return data.commands;
    }

    async function saveCommands(nextCommands) {
        if (busy) return;
        setBusy(true);
        try {
            commands = await requestCommands({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commands: nextCommands })
            });
            render();
            setStatus('Comandos salvos.');
            return true;
        } catch (error) {
            setStatus(error.message || 'Não foi possível salvar os comandos.', true);
            return false;
        } finally {
            setBusy(false);
        }
    }

    function render() {
        list.replaceChildren();
        if (!commands.length) list.textContent = 'Nenhum comando cadastrado.';
        commands.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'saved-command';
            const send = document.createElement('button');
            send.type = 'button';
            send.className = 'saved-command-send';
            const name = document.createElement('strong');
            name.textContent = item.name;
            const text = document.createElement('code');
            text.textContent = item.command;
            send.append(name, text);
            send.addEventListener('click', () => {
                if (busy) return;
                const command = expandCommand(item.command);
                setBusy(true);
                setStatus(`Enviando: ${command}`);
                sendCommand(command, response => {
                    setStatus(
                        `${response?.ok ? 'OK' : 'Erro'}: ${response?.message || 'Sem resposta do backend.'}`,
                        response?.ok !== true
                    );
                    setBusy(false);
                });
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'action-btn';
            remove.textContent = '×';
            remove.title = `Excluir ${item.name}`;
            remove.setAttribute('aria-label', remove.title);
            remove.addEventListener('click', () => {
                if (!busy && confirm(`Excluir o comando "${item.name}"?`)) {
                    saveCommands(commands.filter((_, position) => position !== index));
                }
            });
            row.append(send, remove);
            list.appendChild(row);
        });
    }

    async function setOpen(open) {
        panel.classList.toggle('open', open);
        toggle.classList.toggle('active', open);
        toggle.setAttribute('aria-expanded', String(open));
        panel.setAttribute('aria-hidden', String(!open));
        panel.inert = !open;
        if (!open) {
            toggle.focus();
            return;
        }
        close.focus();
        if (loaded || busy) return;
        setBusy(true);
        setStatus('Carregando comandos...');
        try {
            commands = await requestCommands();
            loaded = true;
            render();
            setStatus('');
        } catch (error) {
            setStatus(error.message || 'Não foi possível carregar os comandos.', true);
        } finally {
            setBusy(false);
        }
    }

    toggle.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    close.addEventListener('click', () => setOpen(false));
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') setOpen(false);
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !loaded || !form.reportValidity()) return;
        const name = nameInput.value.trim();
        const command = commandInput.value.trim();
        if (!name || !command) return;
        if (await saveCommands([...commands, { name, command }])) form.reset();
    });
}
