import BaseWidget from './BaseWidget.js';
import { registerWidgetType } from './WidgetRegistry.js';

const MAX_RELAY_EVENTS = 200;

class RelayWidget extends BaseWidget {
    constructor(title, idContainerDestino, initialData) {
        super(title, idContainerDestino);
        this.element.classList.add('relay-widget');
        this.element.style.width = '780px';
        this.element.style.height = '620px';
        this.events = [];
        this.selectedKey = '';

        const label = document.createElement('label');
        label.className = 'relay-toolbar';
        label.textContent = 'MENSAGEM ';
        this.messageSelect = document.createElement('select');
        this.messageSelect.setAttribute('aria-label', 'Mensagem da missão 3');
        this.messageSelect.addEventListener('change', () => {
            this.selectedKey = this.messageSelect.value;
            this.renderEvents();
        });
        label.appendChild(this.messageSelect);
        this.summary = document.createElement('p');
        this.summary.className = 'relay-summary';
        this.network = document.createElement('div');
        this.network.className = 'relay-network';
        this.timeline = document.createElement('ol');
        this.timeline.className = 'relay-timeline';
        this.content.append(label, this.summary, this.network, this.timeline);
        this.renderEvents();
        if (initialData) this.update(initialData);
    }

    update(packet) {
        if (packet?.modeCode !== '0x32') return;
        const values = packet.values ?? packet;
        if (![values.De, values.Para, values.ICAO, values.Sequencia].every(
            value => Number.isSafeInteger(value) && value >= 0
        )) return;
        const event = {
            from: values.De,
            to: values.Para,
            icao: values.ICAO,
            sequence: values.Sequencia,
            visited: Number.isSafeInteger(values.Visitados) && values.Visitados >= 0
                ? values.Visitados : null,
            timestamp: packet.timestamp,
            receivedTimestamp: packet.receivedTimestamp,
            source: packet.serialSource?.target || '',
        };
        event.key = `${event.icao}:${event.sequence}`;
        if (this.events.some(previous =>
            previous.timestamp === event.timestamp &&
            previous.receivedTimestamp === event.receivedTimestamp &&
            previous.source === event.source && previous.key === event.key &&
            previous.from === event.from && previous.to === event.to &&
            previous.visited === event.visited
        )) return;
        super.update(packet);
        this.events.unshift(event);
        this.events.length = Math.min(this.events.length, MAX_RELAY_EVENTS);
        this.renderEvents();
    }

    messageLabel(event) {
        return `ICAO ${event.icao.toString(16).toUpperCase().padStart(6, '0')} · sequência ${event.sequence}`;
    }

    renderEvents() {
        const messages = new Map();
        for (const event of this.events) {
            if (!messages.has(event.key)) messages.set(event.key, event);
        }
        if (!messages.has(this.selectedKey)) this.selectedKey = '';
        this.messageSelect.replaceChildren();
        const latest = document.createElement('option');
        latest.value = '';
        latest.textContent = 'Acompanhar última mensagem';
        this.messageSelect.appendChild(latest);
        for (const [key, event] of messages) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = this.messageLabel(event);
            this.messageSelect.appendChild(option);
        }
        this.messageSelect.value = this.selectedKey;
        const key = this.selectedKey || this.events[0]?.key;
        const events = this.events.filter(event => event.key === key);
        this.timeline.replaceChildren();
        if (!events.length) {
            this.summary.textContent = '';
            this.network.replaceChildren();
            return;
        }
        const last = events[0];
        this.summary.textContent = `${this.messageLabel(last)} · ${events.length} aviso(s) observado(s) · ` +
            `último salto: Nó ${last.from} → Nó ${last.to} · Visitados: ${last.visited ?? '--'}`;
        this.renderNetwork(events);
        for (const event of events) {
            const row = document.createElement('li');
            const date = event.timestamp ? new Date(event.timestamp) : null;
            const time = date && Number.isFinite(date.getTime())
                ? date.toLocaleTimeString('pt-BR', { hour12: false }) : '--:--:--';
            row.textContent = `${time} · Nó ${event.from} → Nó ${event.to} · Visitados: ${event.visited ?? '--'}`;
            this.timeline.appendChild(row);
        }
    }

    renderNetwork(events) {
        const ids = [...new Set(events.flatMap(event => [event.from, event.to]))].sort((a, b) => a - b);
        const positions = new Map(ids.map((id, index) => {
            const angle = -Math.PI / 2 + index * 2 * Math.PI / ids.length;
            return [id, { x: 320 + 220 * Math.cos(angle), y: 150 + 95 * Math.sin(angle) }];
        }));
        const edges = new Map();
        for (const event of events) {
            const key = `${event.from}:${event.to}`;
            if (!edges.has(key)) edges.set(key, event);
        }
        const last = events[0];
        const paths = [...edges.values()].map(event => {
            const from = positions.get(event.from);
            const to = positions.get(event.to);
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            const x1 = from.x + 25 * Math.cos(angle), y1 = from.y + 25 * Math.sin(angle);
            const x2 = to.x - 30 * Math.cos(angle), y2 = to.y - 30 * Math.sin(angle);
            const active = event.from === last.from && event.to === last.to;
            const path = event.from === event.to
                ? `M ${from.x - 18} ${from.y - 18} c -65 -70 100 -70 36 0`
                : `M ${x1} ${y1} Q ${(x1 + x2) / 2 - 16 * Math.sin(angle)} ${(y1 + y2) / 2 + 16 * Math.cos(angle)} ${x2} ${y2}`;
            return `<g class="relay-edge${active ? ' relay-edge-active' : ''}">
                <path d="${path}" />
                ${event.from === event.to ? '' : `<polygon points="0,0 -10,-5 -10,5" transform="translate(${x2} ${y2}) rotate(${angle * 180 / Math.PI})" />`}
                <title>Nó ${event.from} → Nó ${event.to}</title>
            </g>`;
        }).join('');
        const nodes = ids.map(id => {
            const { x, y } = positions.get(id);
            return `<g class="relay-node${id === last.to ? ' relay-node-active' : ''}">
                <circle cx="${x}" cy="${y}" r="23" />
                <text x="${x}" y="${y + 4}">${id}</text>
                <text class="relay-node-label" x="${x}" y="${y + 40}">Nó ${id}</text>
            </g>`;
        }).join('');
        this.network.innerHTML = `<svg viewBox="0 0 640 300" role="img" aria-label="Saltos observados da mensagem selecionada">
            ${paths}${nodes}
        </svg>`;
    }

    clearData() {
        super.clearData();
        this.events = [];
        this.selectedKey = '';
        this.renderEvents();
    }
}

registerWidgetType('relay', RelayWidget, 'Repasse M3');
export default RelayWidget;
