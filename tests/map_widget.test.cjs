const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Element {
    constructor() {
        this.style = {};
        this.children = [];
        this.listeners = {};
        this.isConnected = true;
        this.clientWidth = 1000;
        this.clientHeight = 800;
    }
    appendChild(item) { this.children.push(item); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    remove() {}
    get offsetWidth() { return Number.parseFloat(this.style.width) || 300; }
    get offsetHeight() { return Number.parseFloat(this.style.height) || 200; }
}

function setup(initialData) {
    const timers = new Map();
    let nextTimer = 0;
    const maps = [];
    const container = new Element();
    const context = {
        document: {
            createElement: () => new Element(),
            getElementById: () => container,
            addEventListener() {}
        },
        ResizeObserver: class {
            observe() {}
            disconnect() { this.disconnected = true; }
        },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        L: {
            map() {
                const map = {
                    layers: new Set(), views: [], handlers: {},
                    setView(position, zoom) { this.views.push(Array.from(position)); this.zoom = zoom; return this; },
                    getZoom() { return this.zoom; },
                    on(event, callback) { this.handlers[event] = callback; },
                    removeLayer(layer) { this.layers.delete(layer); },
                    panTo(position) { this.lastPan = Array.from(position); },
                    invalidateSize() {},
                    remove() { this.removed = true; }
                };
                maps.push(map);
                return map;
            },
            tileLayer: () => ({ addTo() {} }),
            divIcon: options => options,
            marker(position) {
                return {
                    position: Array.from(position), handlers: {},
                    bindTooltip(text) { this.tooltip = text; return this; },
                    addTo(map) { map.layers.add(this); return this; },
                    on(event, callback) { this.handlers[event] = callback; return this; },
                    getLatLng() { return this.position; },
                    setLatLng(next) { this.position = Array.from(next); },
                    setTooltipContent(text) { this.tooltip = text; },
                    getElement() { return null; }
                };
            },
            polyline(positions) {
                return {
                    positions,
                    addTo(map) { map.layers.add(this); return this; },
                    setLatLngs(next) { this.positions = next; },
                    setStyle() {}
                };
            }
        }
    };
    vm.createContext(context);
    for (const name of ['WidgetRegistry.js', 'BaseWidget.js', 'MapWidget.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../flaskr/static/js/widgets', name), 'utf8')
            .replace(/^import .*$/gm, '')
            .replace(/export function /g, 'function ')
            .replace(/^export default (\w+);?$/gm, 'globalThis.$1 = $1;');
        vm.runInContext(source, context, { filename: name });
    }
    const widget = new context.MapWidget('Mapa', 'workspace', initialData);
    function flushTimers() {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(callback => callback());
    }
    return { widget, maps, timers, flushTimers };
}

const aircraft = {
    ICAO: 0xE49763,
    Altitude: 12000,
    Longitude: -46.63,
    Latitude: -23.55,
    Velocidade: 250,
    Track: 90
};

// Regressão baseada em uma amostra 0x30 presente em historico_voo.csv.
{
    const recorded = {
        ICAO: 15205485, Callsign: 0, Altitude: 33000,
        Longitude: -43.98381, Latitude: -19.74335,
        Velocidade: 494, Track: 25
    };
    const { widget, flushTimers } = setup(recorded);
    widget.render(); flushTimers();
    assert.deepEqual(widget.marcadoresAtivos.E8046D.position, [-19.74335, -43.98381]);
    assert.equal(widget.dadosDosVoos.E8046D.speed, 494);
    assert.equal(widget.dadosDosVoos.E8046D.track, 25);
}

// Pacotes reais de Missão 1, tanto achatados pelo main.js como em values.
{
    const { widget, flushTimers } = setup({ values: aircraft });
    assert.equal(widget.dadosDosVoos.E49763.lat, -23.55);
    widget.render();
    widget.update({ ...aircraft, Latitude: -23.56 });
    widget.update({ ...aircraft, ICAO: 0xABC123, Latitude: -24 });
    flushTimers();
    assert.equal(Object.keys(widget.marcadoresAtivos).length, 2);
    assert.deepEqual(widget.marcadoresAtivos.E49763.position, [-23.56, -46.63]);
    assert.deepEqual(widget.map.views.at(-1), [-23.56, -46.63]);
    assert.equal(widget.dadosDosVoos.E49763.speed, 250);
    assert.equal(widget.dadosDosVoos.E49763.track, 90);
    const marker = widget.marcadoresAtivos.E49763;
    widget.update({ values: { ...aircraft, Latitude: -23.57, Altitude: 14000 } });
    assert.equal(widget.marcadoresAtivos.E49763, marker);
    assert.deepEqual(marker.position, [-23.57, -46.63]);
    marker.handlers.click();
    assert(widget.infoPanel.innerHTML.includes('14000'));
    assert.equal(widget.historicoPosicoes.E49763.length, 2);
    marker.slideTo = function (position, options) {
        this.position = Array.from(position);
        this.slideOptions = options;
    };
    const views = widget.map.views.length;
    widget.update({ ...aircraft, Latitude: -23.58 });
    assert.equal(widget.map.views.length, views);
    assert.equal(marker.slideOptions.keepAtCenter, true);
    assert(widget.infoPanel.innerHTML.includes('12000'));
    widget.clearData();
    assert.equal(widget.map.layers.size, 0);
    assert.equal(Object.keys(widget.dadosDosVoos).length, 0);
    assert.equal(widget.aviaoFocado, null);
    widget.update(aircraft);
    assert.equal(widget.historicoPosicoes.E49763.length, 1);
}

// Mantém compatibilidade com a antiga lista de aviões simulados.
{
    const { widget, flushTimers } = setup();
    widget.render(); flushTimers();
    widget.update({ values: { avioes: [{ id: 'TAM3628', hex: 'e49763', lat: -19.9, lng: -43.9, altitude: 1000, speed: 0 }] } });
    assert.equal(widget.dadosDosVoos.TAM3628.hex, 'E49763');
    assert.equal(widget.dadosDosVoos.TAM3628.speed, 0);
    assert.equal(Object.keys(widget.marcadoresAtivos).length, 1);
}

// Dados inválidos não geram marcadores falsos em (0, 0).
{
    const { widget } = setup();
    for (const Latitude of [null, undefined, NaN, Infinity, '', 'NaN', true, 91]) {
        widget.update({ ...aircraft, Latitude });
    }
    widget.update({ ...aircraft, Longitude: 181 });
    widget.update({ ...aircraft, ICAO: null });
    widget.update({ ...aircraft, ICAO: 0x1000000 });
    assert.equal(Object.keys(widget.dadosDosVoos).length, 0);
    widget.update({ ...aircraft, Latitude: 0, Longitude: 0, Altitude: null, Velocidade: null });
    assert.equal(widget.dadosDosVoos.E49763.lat, 0);
    assert.equal(widget.dadosDosVoos.E49763.altitude, null);
}

// Movimento manual não é desfeito pela chegada do primeiro avião.
{
    const { widget, maps, flushTimers } = setup();
    widget.render(); flushTimers();
    widget.map.handlers.dragstart();
    widget.update(aircraft);
    assert.equal(widget.map.views.length, 1);
    widget.render(); flushTimers();
    assert.equal(maps.length, 1);
    const map = widget.map;
    widget.cleanup();
    assert.equal(map.removed, true);
    assert.equal(widget.map, null);
}

// Fecha com segurança antes de o Leaflet inicializar e escapa rótulos recebidos.
{
    const { widget, timers, flushTimers } = setup();
    widget.render();
    widget.cleanup();
    assert.equal(timers.size, 0);
    flushTimers();
    const next = setup();
    next.widget.render(); next.flushTimers();
    next.widget.update({ ...aircraft, Callsign: '<img src=x onerror=alert(1)>' });
    const marker = next.widget.marcadoresAtivos.E49763;
    assert(!marker.tooltip.includes('<img'));
    marker.handlers.click();
    assert(!next.widget.infoPanel.innerHTML.includes('<img'));
}

console.log('OK: Missao 1, ICAO, coordenadas, cache antes do Leaflet, camera, rastros, legado e limpeza.');
