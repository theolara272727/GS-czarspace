const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

class Element {
    constructor() {
        this.style = {};
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.dataset = {};
        this.value = '';
        this.disabled = false;
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
            contains: name => classes.has(name)
        };
    }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); }
    replaceChildren() { this.children = []; this.innerHTML = ''; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() {}
    reportValidity() { return true; }
    reset() {}
    get offsetWidth() { return 300; }
    get offsetHeight() { return 200; }
    querySelectorAll() {
        const result = [];
        function visit(node) { result.push(node); node.children.forEach(visit); }
        this.children.forEach(visit);
        return result;
    }
}

function load(context, filename) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/export default function /g, 'function ')
        .replace(/export function /g, 'function ')
        .replace(/^export default (\w+);?$/gm, 'globalThis.$1 = $1;');
    vm.runInContext(source, context, { filename });
}

function makeContext() {
    const elements = new Map();
    const context = {
        document: {
            createElement: () => new Element(),
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, new Element());
                return elements.get(id);
            },
            addEventListener() {}
        },
        window: {},
        requestAnimationFrame: callback => callback(),
        confirm: () => true,
        AbortSignal: { timeout() {} }
    };
    vm.createContext(context);
    return context;
}

function testTerminal() {
    const context = makeContext();
    for (const filename of ['WidgetRegistry.js', 'BaseWidget.js', 'terminalWidget.js']) {
        load(context, `flaskr/static/js/widgets/${filename}`);
    }
    const writes = [];
    const widget = new context.rawDataWidget('Terminal', 'workspace', {}, (command, callback, target) => {
        writes.push({ command, target });
        callback({ ok: true, message: 'sent' });
    });
    const lines = [];
    widget.appendLine = line => lines.push(line);
    widget.targetSelect.value = 'uwb';
    widget.targetSelect.listeners.change();
    widget.sendTerminalCommand('P');
    assert.deepEqual(writes, [{ command: 'P', target: 'uwb' }]);
    assert.equal(widget.targetSelect.disabled, false);
    assert.equal(widget.serialize().serialTarget, 'uwb');
    widget.applyState({ serialTarget: 'both' });
    widget.sendTerminalCommand('STATUS');
    assert.equal(writes.at(-1).target, 'both');
    assert.equal(widget.serialize().serialTarget, 'both');
    assert(widget.targetSelect.children.some(option => option.textContent === 'DW1000'));
    assert(widget.targetSelect.children.some(option => option.value === 'both'));
    widget.applyState({ serialTarget: 'main' });
    widget.sendTerminalCommand('STATUS');
    assert.equal(writes.at(-1).target, 'main');
    widget.applyState({});
    assert.equal(widget.serialTarget, 'main');
    widget.receiveSerialData({ target: 'uwb', port: 'COM15', baud: 115200, text: 'D,0,1,3.5,-60,100\r\n' });
    assert(lines.at(-1).includes('DW1000') && lines.at(-1).includes('COM15'));
    widget.receiveSerialData({ target: 'main', port: 'COM14', baud: 115200, text: 'ACK\r\n' });
    assert(lines.at(-1).includes('Principal') && lines.at(-1).includes('COM14'));
    widget.update({ timestamp: '2026-11-16T12:00:00Z', V_bateria: 8.7, serialSource: { target: 'main', port: 'COM14' } });
    assert(lines.at(-1).includes('COM14'));
    assert(!lines.at(-1).includes('[object Object]'));
    widget.showCommandResult({ ok: false, message: 'Falha de envio' });
    assert.equal(lines.at(-1), 'Erro: Falha de envio');
}

async function testCommandPanel() {
    const context = makeContext();
    let saved = [{ name: 'iniciar', command: 'G 00 {timestamp}', target: 'main' }];
    context.fetch = async (url, options) => {
        assert.equal(url, '/commands');
        if (options.method === 'POST') saved = JSON.parse(options.body).commands;
        return { ok: true, json: async () => ({ commands: saved }) };
    };
    load(context, 'flaskr/static/js/CommandPanel.js');
    const writes = [];
    context.initCommandPanel((command, callback, target) => {
        writes.push({ command, target });
        callback({ ok: true, message: 'sent' });
    });
    const element = id => context.document.getElementById(id);
    await element('commandsButton').listeners.click();
    let row = element('savedCommands').children[0];
    row.children[0].listeners.click();
    assert.equal(writes[0].target, 'main');
    assert.equal(element('commandsStatus').textContent, '');
    assert.match(writes[0].command, /^G 00 \d+$/);
    row.children[1].value = 'uwb';
    await row.children[1].listeners.change();
    assert.equal(saved[0].target, 'uwb');
    row = element('savedCommands').children[0];
    row.children[0].listeners.click();
    assert.equal(writes[1].target, 'uwb');
    row.children[1].value = 'both';
    await row.children[1].listeners.change();
    assert.equal(saved[0].target, 'both');
    element('savedCommands').children[0].children[0].listeners.click();
    assert.equal(writes.at(-1).target, 'both');
    element('commandName').value = 'Pares';
    element('commandText').value = 'P';
    element('commandTarget').value = 'both';
    await element('commandCreateForm').listeners.submit({ preventDefault() {} });
    assert.equal(saved[1].target, 'both');
    assert.equal(saved[1].command, 'P');
}

function testStreamRouting() {
    const context = makeContext();
    const handlers = {};
    const sent = [];
    context.io = () => ({
        on: (event, callback) => { handlers[event] = callback; },
        timeout: () => ({ emit: (event, payload, callback) => {
            sent.push({ event, payload });
            callback(null, { ok: true });
        } })
    });
    const mainUpdates = [], uwbUpdates = [], historicalUwbUpdates = [], terminalTelemetry = [];
    context.mainWidget = {
        update: data => mainUpdates.push(data),
        receiveSerialTelemetry: data => terminalTelemetry.push(data)
    };
    context.uwbWidget = {
        update: data => historicalUwbUpdates.push(data),
        updateUwbTelemetry: data => uwbUpdates.push(data)
    };
    load(context, 'flaskr/static/js/main.js');
    vm.runInContext("widget_list.push(mainWidget, uwbWidget); currentMode = {code: '0x10'};", context);
    const mainStatus = context.document.getElementById('serial-main-status');
    const uwbStatus = context.document.getElementById('serial-uwb-status');
    handlers.connect();
    assert.equal(mainStatus.classList.contains('connected'), false);
    assert.equal(uwbStatus.classList.contains('connected'), false);
    handlers.serial_status({ target: 'main', connected: true, port: 'COM14', baud: 115200 });
    assert(mainStatus.innerHTML.includes('NOMINAL'));
    assert(mainStatus.classList.contains('connected'));
    assert(mainStatus.title.includes('COM14'));
    assert.equal(uwbStatus.classList.contains('connected'), false);
    handlers.serial_status({ target: 'uwb', connected: false, message: 'Porta ocupada' });
    assert(uwbStatus.innerHTML.includes('OFFLINE'));
    assert(uwbStatus.classList.contains('offline'));
    assert.equal(uwbStatus.title, 'Porta ocupada');
    handlers.serial_status({ target: 'uwb', connected: true, port: 'COM15' });
    assert(uwbStatus.classList.contains('connected'));
    assert.equal(uwbStatus.classList.contains('offline'), false);
    handlers.disconnect();
    for (const status of [mainStatus, uwbStatus]) {
        assert(status.innerHTML.includes('STANDBY'));
        assert.equal(status.classList.contains('connected'), false);
        assert.equal(status.classList.contains('offline'), false);
    }
    handlers.new_data({ modeCode: '0x10', values: { V_bateria: 8.7 }, serialSource: { target: 'main', port: 'COM14' } });
    handlers.uwb_data({ modeCode: '0x10', values: { dA1: 3.5 }, serialSource: { target: 'uwb', port: 'COM15' } });
    assert.equal(mainUpdates.length, 1);
    assert.equal(uwbUpdates.length, 1);
    assert.equal(mainUpdates[0].V_bateria, 8.7);
    assert.equal(historicalUwbUpdates.length, 0);
    assert.equal(uwbUpdates[0].values.dA1, 3.5);
    vm.runInContext("currentMode = {code: '0x1'};", context);
    handlers.uwb_data({ values: { dA1: 4 } });
    assert.equal(uwbUpdates.length, 2);
    handlers.serial_telemetry({ values: { Origem: 0 }, serialSource: { target: 'uwb' } });
    assert.equal(terminalTelemetry.length, 1);
    vm.runInContext("viewMode = 'historical';", context);
    handlers.uwb_data({ values: { dA1: 5 } });
    assert.equal(uwbUpdates.length, 2);
    context.playHistoricalSamples([{
        timestamp: '2026-11-18T12:00:01Z', modeCode: '0x31',
        serialSource: { target: 'uwb' }, dA1: 3, d12: 2
    }], 1);
    assert.equal(historicalUwbUpdates.length, 1);
    assert.equal(historicalUwbUpdates[0].dA1, 3);
    assert.equal(historicalUwbUpdates[0].serialSource.target, 'uwb');
    context.sendSerialCommand('P', () => {}, 'uwb');
    assert.equal(sent[0].payload.target, 'uwb');
    assert.equal(sent[0].event, 'serial_command');
}

function testConstellationAcceptsUwbPacket() {
    const context = makeContext();
    for (const file of ['WidgetRegistry.js', 'BaseWidget.js', 'ConstellationWidget.js']) {
        load(context, `flaskr/static/js/widgets/${file}`);
    }
    const widget = Object.create(context.ConstellationWidget.prototype);
    widget.hud = {};
    widget.isAutoZoomEnabled = false;
    widget.sats = Array.from({ length: 4 }, () => ({
        position: { set() {} }, userData: { targetPosition: {
            set(x, y, z) { this.coordinates = [x, y, z]; }
        } }
    }));
    widget.updateUwbTelemetry({ values: { dA1: 3, dA2: 4, dA3: 5, d12: 2, d13: 2, d23: 3 } });
    assert.equal(widget.data.dA1, 3);
    assert(widget.hud.innerHTML.includes('3.000 m'));
    const initial = widget.sats.map(sat => sat.userData.targetPosition.coordinates);
    context.Date = { now: () => 9999999999999 };
    widget.updateUwbTelemetry({ values: { dA1: 3, dA2: 4, dA3: 5, d12: 2, d13: 2, d23: 3 } });
    assert.deepEqual(widget.sats.map(sat => sat.userData.targetPosition.coordinates), initial);
    assert.equal(initial[1][1], 0);
    widget.updateUwbTelemetry({ values: { dA1: 3, dA2: 5, dA3: 5, d12: 3, d13: 2, d23: 3 } });
    assert.notDeepEqual(widget.sats[2].userData.targetPosition.coordinates, initial[2]);
    widget.update({
        timestamp: '2026-11-18T12:00:01Z', modeCode: '0x31',
        serialSource: { target: 'uwb' }, dA1: 6, dA2: 5, dA3: 5, d12: 3, d13: 2, d23: 3
    });
    assert.equal(widget.data.dA1, 6);
    assert(widget.hud.innerHTML.includes('6.000 m'));
}

function testPanelFeedbackGoesToTerminal() {
    const context = makeContext();
    const terminals = [];
    const sent = [];
    let response = { ok: true, message: 'sent' };
    context.terminalWidget = class {
        constructor() {
            this.closeWidget = new Element();
            this.commands = [];
            this.results = [];
            terminals.push(this);
        }
        render() { this.rendered = true; }
        applyState(state) { this.serialTarget = state.serialTarget; }
        showCommandSent(command, target) { this.commands.push({ command, target }); }
        showCommandResult(result) { this.results.push(result); }
    };
    context.io = () => ({
        on() {},
        timeout: () => ({ emit: (event, payload, callback) => {
            sent.push(payload);
            callback(null, response);
        } })
    });
    load(context, 'flaskr/static/js/main.js');
    let completed = false;
    context.sendPanelCommand('P', () => { completed = true; }, 'uwb');
    assert(completed);
    assert.equal(terminals.length, 1);
    assert(terminals[0].rendered);
    assert.equal(terminals[0].serialTarget, 'uwb');
    assert.equal(terminals[0].commands[0].target, 'uwb');
    assert.equal(terminals[0].results[0].message, 'sent');
    response = { ok: false, message: 'disconnected' };
    context.sendPanelCommand('STATUS', () => {}, 'both');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].results[1].ok, false);
    assert.equal(sent[1].target, 'both');
}

function testTerminalReceiveFilter() {
    const context = makeContext();
    for (const filename of ['WidgetRegistry.js', 'BaseWidget.js', 'terminalWidget.js']) {
        load(context, `flaskr/static/js/widgets/${filename}`);
    }
    const widget = new context.rawDataWidget('Terminal', 'workspace', {}, () => {});
    const visible = () => widget.output.children.filter(line => !line.hidden);
    widget.receiveSerialData({ target: 'main', port: 'COM14', baud: 115200, text: 'MAIN ACK' });
    widget.receiveSerialData({ target: 'uwb', port: 'COM15', baud: 115200, text: 'D,0,1,3.5,-60,100' });
    assert.equal(visible().length, 1);
    assert(visible()[0].innerText.includes('COM14'));
    widget.update({ V_bateria: 8.7, serialSource: { target: 'main', port: 'COM14' } });
    assert.equal(visible().length, 2);
    widget.targetSelect.value = 'uwb';
    widget.targetSelect.listeners.change();
    assert.equal(visible().length, 1);
    assert(visible()[0].innerText.includes('COM15'));
    widget.showCommandResult({ ok: false, results: [
        { target: 'main', ok: true, message: 'main sent' },
        { target: 'uwb', ok: false, message: 'dw1000 failed' }
    ] }, 'both');
    assert.equal(visible().length, 2);
    assert(visible()[1].innerText.includes('dw1000 failed'));
    assert(!visible().some(line => line.innerText.includes('main sent')));
    widget.applyState({ serialTarget: 'both' });
    assert.equal(visible().length, 5);
    widget.applyState({ serialTarget: 'main' });
    assert.equal(visible().length, 3);
    widget.showCommandResult({ ok: false, message: 'Timeout DW1000' }, 'uwb');
    assert.equal(visible().length, 3);
    widget.applyState({ serialTarget: 'uwb' });
    assert(visible().some(line => line.innerText.includes('Timeout DW1000')));
    widget.clearData();
    assert.equal(visible().length, 0);
    assert.equal(widget.serialTarget, 'uwb');
    widget.receiveSerialTelemetry({
        timestamp: '2026-11-16T12:00:00Z',
        values: { Origem: 0, D_GS: null, D_Gabriella: null, D_Carolina: null, D_Beatriz: 0.4172446 },
        serialSource: { target: 'uwb', port: 'COM15' }
    });
    assert.equal(visible().length, 1);
    assert(visible()[0].innerText.includes('Origem: 0.00 |'));
    assert(visible()[0].innerText.includes('D_Beatriz: 0.42 |'));
    assert(!visible()[0].innerText.includes('null'));
    widget.applyState({ serialTarget: 'main' });
    assert.equal(visible().length, 0);
}

function testRelayWidget() {
    const context = makeContext();
    for (const file of ['WidgetRegistry.js', 'BaseWidget.js', 'RelayWidget.js']) {
        load(context, `flaskr/static/js/widgets/${file}`);
    }
    const widget = new context.RelayWidget('Repasse M3', 'workspace');
    const packet = {
        modeCode: '0x32', timestamp: '2026-11-19T12:00:00Z',
        values: { De: 2, Para: 3, Visitados: 4, ICAO: 0xABC123, Sequencia: 42 }
    };
    assert.equal(widget.summary.textContent, '');
    widget.update(packet);
    assert(widget.summary.textContent.includes('ABC123'));
    assert(widget.summary.textContent.includes('sequência 42'));
    assert(widget.timeline.children[0].textContent.includes('Nó 2 → Nó 3'));
    assert(widget.network.innerHTML.includes('<svg'));
    widget.update(packet);
    assert.equal(widget.timeline.children.length, 1);
    widget.update({ ...packet, timestamp: '2026-11-19T12:00:01Z', values: {
        ...packet.values, De: 3, Para: 1, Visitados: 12
    } });
    assert.equal(widget.timeline.children.length, 2);
    assert(widget.network.innerHTML.includes('Nó 2 → Nó 3'));
    assert(widget.network.innerHTML.includes('Nó 3 → Nó 1'));
    assert(widget.summary.textContent.includes('Visitados: 12'));
    widget.update({ ...packet, values: { ...packet.values, ICAO: 0xABC124 } });
    assert.equal(widget.timeline.children.length, 1);
    assert(widget.summary.textContent.includes('ABC124'));
    widget.messageSelect.value = `${0xABC123}:42`;
    widget.messageSelect.listeners.change();
    assert.equal(widget.timeline.children.length, 2);
    widget.update({ ...packet, modeCode: '0x31' });
    widget.update({ ...packet, values: { ...packet.values, De: null } });
    widget.update({ ...packet, values: { ...packet.values, Para: '<script>' } });
    assert.equal(widget.timeline.children.length, 2);
    const spec = widget.serialize();
    assert.equal(spec.type, 'relay');
    const restored = context.createWidgetFromSpec(spec, { containerId: 'workspace' });
    assert(restored instanceof context.RelayWidget);
    widget.clearData();
    assert.equal(widget.summary.textContent, '');
    assert.equal(widget.timeline.children.length, 0);
    assert.equal(widget.network.innerHTML, '');
    for (let sequence = 0; sequence < 205; sequence++) {
        widget.update({ ...packet, values: { ...packet.values, Sequencia: sequence } });
    }
    assert.equal(widget.messageSelect.children.length, 201);
    assert(!widget.messageSelect.children.some(option => option.value === `${0xABC123}:0`));
}

function testRelayLiveAndReplay() {
    const context = makeContext();
    const handlers = {};
    context.io = () => ({ on: (event, callback) => { handlers[event] = callback; } });
    for (const file of ['WidgetRegistry.js', 'BaseWidget.js', 'RelayWidget.js']) {
        load(context, `flaskr/static/js/widgets/${file}`);
    }
    load(context, 'flaskr/static/js/main.js');
    context.relay = new context.RelayWidget('Repasse M3', 'workspace');
    vm.runInContext("widget_list.push(relay); currentMode = {code: '0x32'};", context);
    handlers.new_data({ modeCode: '0x32', timestamp: '2026-11-19T12:00:00Z', values: {
        De: 2, Para: 3, ICAO: 0xABC123, Sequencia: 42, Visitados: 4
    } });
    assert(context.relay.summary.textContent.includes('Nó 2 → Nó 3'));
    vm.runInContext("viewMode = 'historical';", context);
    context.playHistoricalSamples([{
        modeCode: '0x32', timestamp: '2026-11-18T12:00:00Z',
        De: 3, Para: 1, ICAO: 0xABC124, Sequencia: 8, Visitados: 12
    }], 1);
    assert.equal(context.relay.timeline.children.length, 1);
    assert(context.relay.summary.textContent.includes('ABC124'));
    handlers.new_data({ modeCode: '0x32', values: {
        De: 0, Para: 2, ICAO: 0xABC125, Sequencia: 9
    } });
    assert(context.relay.summary.textContent.includes('ABC124'));
}

(async () => {
    testTerminal();
    await testCommandPanel();
    testStreamRouting();
    testConstellationAcceptsUwbPacket();
    testPanelFeedbackGoesToTerminal();
    testTerminalReceiveFilter();
    testRelayWidget();
    testRelayLiveAndReplay();
    console.log('OK: serial, isolamento Principal/UWB e Repasse M3 ao vivo/replay, seleção, limites e persistência.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
